# 24 — Voice input (browser-side and server-side)

Issue #47 adds an optional **on-device** dictation path while keeping the
existing server path untouched. The microphone is rendered whenever *either*
path is available; a visible label always says which one is active.

## Paths and preference

| Path | Trigger | Transcript route | Network during recording |
| --- | --- | --- | --- |
| local | pinned model files present and consent given | Web Worker → Transformers.js → composer | `/models/…` on first use only, then Cache Storage |
| server | `STT_URL` configured, or local failed | `POST /api/transcribe` → `STT_URL` | audio leaves the device |

Preference is automatic: local first, otherwise server. There is no manual
override control in v1 — the consent dialog's **Use server STT** action and the
runtime fallback persist a server preference instead. On a local model-load
failure with a configured server, the same audio is retried once against
`/api/transcribe` and the label switches to *via server*. If there is no server,
a stable error code is shown (`model_unavailable`, `model_download_failed`,
`out_of_memory`, `unsupported`, `empty_transcript`); the button is never silent.

## Provisioning the model (operator step)

Weights are **never fetched from a third party at runtime**. Download them once
on the deployment host:

```sh
pnpm run stt:fetch
# optional: --dir /srv/openchat/models  (or set STT_MODEL_DIR)
```

The script downloads a pinned set from `onnx-community/whisper-base` revision
`27a07b4b52b3a4c5886134bb4320e93e1a4bbc7c` and the pinned ONNX Runtime Web
`1.31.0-dev.20260914-8d85527a0` binaries, verifies SHA-256 and byte count per
file, resumes interrupted downloads from `.part`, and refuses a mismatched file
with the expected and actual digests. The manifest lives in
`packages/contracts/src/stt-model.ts`. Files are written to
`apps/web/public/models/` (gitignored) by default.

**Exact size from the manifest: 134,978,761 bytes (≈129 MiB / 135 MB).**
That is the quantized `q8` Whisper base (multilingual, ~76 MB) plus both ORT
WASM runtimes (single-threaded `asyncify` for CPU and `jsep` for WebGPU,
~55 MB). The issue's 206 MB estimate refers to the unquantized fp32 model.

The BFF serves that directory read-only under `/models/` with immutable
caching, `X-Content-Type-Options: nosniff`, a 404 for missing files and a
realpath-confined path check (no traversal, no symlink escapes). `/api/info`
reports `dictation: { enabled, maxSeconds, maxBytes, local: { available,
model }, server: { available } }`. `local.available` is true only when every
pinned file exists. `enabled` keeps its old meaning: the microphone is usable.

## Consent, download and cache

Nothing is downloaded on page load or on opening the composer. The first press
with the local path opens a dialog showing the exact manifest size, the purpose
(*runs only on this device, audio never leaves it*) and three actions:
**Download**, **Use server STT** (only when configured) and **Cancel**.
Cancel/decline is persisted and never asked again. Only **Download** starts a
request, to our own origin under `/models/`.

The worker streams byte progress to the UI via `progress` messages; cancelling
terminates the worker and the response stream. Bytes are stored in a dedicated
Cache Storage named `openchat-stt-<manifest version>` (currently
`openchat-stt-27a07b4b52b3a4`). Transformers.js' own browser cache is disabled,
so there is exactly one copy. Subsequent sessions are served from that cache:
no `/models/` request while the manifest version is unchanged. A new version
deletes stale `openchat-stt-*` caches; a small size change keeps the previous
consent, a substantial one asks again. **Delete downloaded speech model** in
the composer removes the cache and resets consent.

The service worker from the PWA workstream must not precache `/models/`. This
cache is separate and is not touched by service-worker versioning.

## Browser support

| Browser | Backend | Notes |
| --- | --- | --- |
| Chrome / Edge ≥ 113 with WebGPU | WebGPU (`jsep`) | Fastest; falls back to WASM if the adapter fails |
| Chrome / Edge without WebGPU | WASM (`asyncify`, single-threaded) | No cross-origin isolation needed |
| Firefox desktop | WASM | WebGPU support varies by release/flags |
| Safari 16+ | WASM | Single-threaded build; no SharedArrayBuffer |
| iOS Safari | WASM, only if the device has enough memory; otherwise server path | ~129 MB budget is tight |

The worker probes `navigator.gpu.requestAdapter()` before selecting a device.
Merely seeing `navigator.gpu` is not enough: headless and virtualized browsers
expose the API but have no adapter, and a failed WebGPU session poisons the ONNX
backend so a later WASM retry fails with the same error. Without an adapter the
worker goes straight to WASM. Recordings are decoded at Whisper's native 16 kHz;
decoding at the device rate and resampling twice measurably degraded
`whisper-base`. Browsers that reject a custom `AudioContext` rate fall back to
their default context.

## Why no COOP/COEP

Threaded WASM would want cross-origin isolation, but enabling `Cross-Origin-
Opener-Policy`/`Cross-Origin-Embedder-Policy` on the app origin would change how
the artifact iframe (a separate origin, see architecture 03) is embedded and
would break existing deployments. The single-threaded `asyncify` build runs
without isolation; WebGPU is used where available. We measure before changing
the document's isolation policy.

## Bundling

`@huggingface/transformers` is pinned to `4.3.2` — the current release whose
web build exposes `env.fetch`, so all weight reads can be routed through the
same-origin cache; newer prereleases were avoided. It is imported dynamically
inside the Web Worker, so it lands in a lazy worker chunk. The bundle gate
(`scripts/check-bundle.ts`) asserts the worker is a lazy asset and that the ONNX
runtime never appears in the entry chunk. The model weights are data under
`public/models/`, never Vite assets.

## Manual smoke test (host/desktop, real weights, no real microphone)

```sh
pnpm run stt:fetch
pnpm run stt:smoke
# or with a 16-bit PCM WAV clip:
pnpm run stt:smoke -- --audio /path/to/sample.wav --expect "Diktat,lokal"
```

On macOS without `--audio`, the script synthesizes
`Das Diktat läuft lokal im Browser.` with `say` into a temporary WAV. It then
verifies every file's size and SHA-256, runs the real Whisper pipeline through
a same-origin-only fetch and prints the transcript.

**Expected:** the transcript contains `Diktat` and `lokal` (case-insensitive),
and the second run causes **zero** `/models/` fetches — the output line reads
`second=0`. Any external URL in the fetch log fails the test.

## Deliberate omissions (v1)

- **Streaming partial transcripts**: only the final transcript is inserted.
- **Model variants**: only `whisper-base` q8 is pinned; `tiny`/`small` are not provisioned.
- **Mobile limits**: iOS relies on the memory check and the server fallback; there is no dedicated mobile UI or smaller model yet.
