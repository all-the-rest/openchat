# 03 — Dictation (V2, FR-34 … FR-36)

**Status:** 2026-11-17. Web side of dictation: the microphone control, the
browser capture, the transcription request and the caret insertion. The BFF
route and the contract types are described by their fixed wire surface; the
behavior specification stays in `docs/spec/04-composer.md`.

## Flow

```
MediaRecorder (device-local capture)
  │  Blob with the first supported type:
  │  audio/webm;codecs=opus → audio/mp4 → audio/ogg
  ▼
POST /api/transcribe?language=<locale>        same origin, cookies included
  │  raw audio body, content-type = base MIME (audio/webm, audio/mp4, audio/ogg)
  ▼
BFF :8787 ──▶ Whisper-compatible STT (STT_URL)
  │  200 { text, durationMs }
  ▼
Composer: insert at the caret in the draft
```

The transcript is never sent: it becomes editable text in the composer, and the
owner can correct it before pressing Enter. No audio is written to disk by the
web app, none is kept after transcription, and no object URL is created for
playback.

## Components

| File | Responsibility |
| --- | --- |
| `apps/web/src/dictation/useDictation.ts` | state machine, permission, limits, request, retry |
| `apps/web/src/dictation/recorder.ts` | `MediaRecorder`/`AudioContext` objects, RMS level, teardown, blob assembly |
| `apps/web/src/dictation/format.ts` | MIME preference, base MIME, `m:ss`, byte formatting |
| `apps/web/src/dictation/errors.ts` | capture and BFF failures → one error code each |
| `apps/web/src/dictation/useDictationConfig.ts` | reads `dictation` from `GET /api/info` once per page |
| `apps/web/src/dictation/DictationButton.tsx` | pointer/keyboard gestures, busy state, accessible name |
| `apps/web/src/dictation/RecordingPill.tsx` | elapsed clock, RMS meter, stop and cancel |
| `apps/web/src/dictation/DictationFeedback.tsx` | busy line, limit note, error alert, retry |
| `apps/web/src/chat/Composer.tsx` | wires the hook, caret insertion, focus |

`Composer` accepts an explicit `dictation` prop for tests; in the app it is
omitted and the capability is read from `/api/info`. A missing or failed answer
means "off": no button, and no microphone request.

## State machine

| State | Entered by | Visible | Leaves by |
| --- | --- | --- | --- |
| `idle` | mount, cancel, successful insert | mic button | pointer press / Enter / Space → `requesting` |
| `requesting` | `begin()` inside the gesture | pill "Requesting microphone…", cancel | permission granted → `recording`; denied/failed → `error`; Escape or cancel → `idle` |
| `recording` | `recorder.start(500)` | pill with `m:ss`, level meter, stop, cancel | stop, byte limit or time limit → `transcribing`; Escape or cancel → `idle`; unmount → teardown |
| `transcribing` | recorder stopped, or retry | spinner on the button, "Transcribing…" | 200 with text → `idle` + insert; any failure → `error` |
| `error` | capture or transcription failure | alert with message, Retry, dismiss | Retry → `transcribing` (same blob) or `requesting` (new capture); mic press → `requesting` |

```
idle ──press/key──▶ requesting ──granted──▶ recording ──stop/limit──▶ transcribing
  ▲                     │                      │                          │
  │                  denied                    Escape/cancel          success + insert
  │                     ▼                      ▼                          │
  └──── dismiss ◀──── error ◀──── failure ◀──── idle ◀─────────────────────┘
```

`getUserMedia` is called from the pointer-down/key-down handler, never from an
effect. That satisfies iOS Safari's gesture requirement and the spec rule that
no permission prompt appears on page load.

## Gestures and keyboard

- **Press and hold**: pointer down starts capture; once capture has started,
  releasing after at least 350 ms stops and transcribes. A release while the
  permission prompt is still open cancels the gesture: the granted stream is
  stopped, nothing is stored, and the next press starts over.
- **Click to toggle**: a shorter first press keeps recording hands-free; the
  next click stops. The click event that belongs to the starting press is
  ignored, so one click never starts and stops at once.
- **Enter / Space** on the focused button toggles recording. `keydown` calls
  `preventDefault`, so the native click cannot toggle twice.
- **Escape** cancels while `requesting` or `recording`. The listener sits on
  `window` in the capture phase and stops propagation, so recording wins over a
  menu that also reacts to Escape.
- **Unmount** (route change) tears the recorder down, stops all tracks, closes
  the `AudioContext` and discards the chunks; the microphone is never left open.

## Configuration

| Knob | Source | Default | Use |
| --- | --- | --- | --- |
| `dictation.enabled` | `GET /api/info` | absent → off | renders the button only when true |
| `dictation.maxSeconds` | `GET /api/info` | 120 | checked every 100 ms; reaching it stops capture and transcribes the existing audio |
| `dictation.maxBytes` | `GET /api/info` | 25 MiB | `dataavailable` chunks accumulate (500 ms timeslice); a chunk that would cross the cap is dropped, so the blob never exceeds it |
| `?language` | current UI locale (`en`, `de`) | — | optional hint for the STT service |

The time and byte limits both keep what was recorded: the note
(`dictation.limit.time` / `dictation.limit.size`) stays visible while the
transcript arrives and is cleared by the next recording.

## Errors

| UI code | Trigger | Message key |
| --- | --- | --- |
| `permission` | `getUserMedia` rejects with `NotAllowedError`, `PermissionDeniedError`, `SecurityError` | `dictation.error.permission` |
| `no_device` | `NotFoundError`, `DevicesNotFoundError`, `OverconstrainedError` | `dictation.error.noDevice` |
| `unsupported` | no candidate passes `MediaRecorder.isTypeSupported`, recorder construction fails, or `mediaDevices` is missing; BFF `415 unsupported_media_type` | `dictation.error.unsupported` |
| `too_large` | BFF `413 payload_too_large` | `dictation.error.tooLarge` |
| `unavailable` | BFF `503 stt_unavailable` | `dictation.error.unavailable` |
| `timeout` | BFF `504 stt_timeout` | `dictation.error.timeout` |
| `empty_transcript` | BFF `422 empty_transcript`, or a blank `text` in a 200 | `dictation.error.empty` |
| `failed` | BFF `502 stt_failed`, recorder failure, or an unmapped status | `dictation.error.failed` |
| `network` | `fetch` rejected before a response (`TypeError`) | `dictation.error.network` |

Every error is a `role="alert"` line below the composer. **Retry** re-sends the
same blob for a transcription failure; for a capture failure, or after an empty
transcript (the client-side blank branch or a BFF `422`), it starts a new
recording, because the same bytes cannot produce words on a second attempt. The
draft is never touched by an error, and `Dismiss` clears the alert without
changing the draft.

## Tests

| File | Cases |
| --- | --- |
| `apps/web/test/dictation.test.tsx` | hides the microphone when disabled; never requests the microphone on mount; reads `/api/info` when no override is given; denied permission sends no request; no supported format fails loudly before `getUserMedia`; cancel sends no request and keeps the draft; stop sends the recorded MIME, shows "Transcribing…", inserts at the caret and keeps focus; empty transcript keeps the draft; 503 keeps the recording and retries the same blob; 504 is recoverable; the blob never crosses the byte limit; the time limit auto-stops with a note; releasing a held microphone stops the capture; a short press stays hands-free until the next click; a `422` retry starts a new recording |
| `apps/web/test/dictation-keyboard.test.tsx` | Escape cancels and sends nothing; Enter toggles on and off; Space toggles on and off |
| `apps/web/test/dictation-format.test.ts` | MIME preference order and no-format case; codec parameter dropped from the request; `m:ss`; byte formatting |
| `apps/web/test/dictation-harness.tsx` | doubles for `navigator.mediaDevices.getUserMedia`, `MediaRecorder`, `AudioContext`/`AnalyserNode`, `fetch`, `URL.createObjectURL`; shared composer render and start helper |
| `apps/web/test/composer.test.tsx` | unchanged: send, Shift+Enter, failed send keeps the draft, stop button |

The caret case uses the draft `Dear , please review.` with the caret at index 5
and the transcript `Ada`; the result is `Dear Ada, please review.` with the
caret at 8 and focus back in the textarea. Keyboard cases focus the button and
assert the pill appears on the first key and the request happens on the second.

## Verification

```text
pnpm --filter @openchat/web run test   # 15 files, 91 tests
pnpm run lint                          # i18n gate + all workspace typechecks
pnpm run typecheck                     # all workspace typechecks
pnpm run build                         # web, server, packages
wc -l apps/web/src/chat/* apps/web/src/dictation/*
node scripts/count-long-files.ts       # 0
node scripts/count-tests.ts            # 203
```

All new files stay below 400 lines. This slice adds 40 declarations in total
(163 → 203), including the BFF, web and one E2E spec; the ratchet baseline
moves 163 → 203 in the same commit.

## Not covered

- **Live partial text.** The spec marks it optional; there is no streaming STT
  path, so the UI shows "Transcribing…" and inserts once.
- **Audio review before sending.** Cancel discards; there is no playback or
  waveform of the finished recording.
- **Aborting an in-flight transcription.** Dismiss and unmount ignore a late
  result; the HTTP request is not cancelled.
- **Browser matrix.** MIME selection and the gesture path are unit-tested with
  doubles; Safari/iOS and a real microphone are manual checks.
- **Hold released during the permission prompt.** The stream that arrives
  afterwards is stopped and the control returns to idle without an error; a
  second press is needed. `pointerup` while the browser's permission bubble is
  open is not automated (the E2E auto-accepts).
- **Server and STT behavior.** Timeouts, the Whisper call and the file-size cap
  are the BFF's tests, not this suite. The web side only maps the documented
  status codes.
- **Screenshots.** The recording pill is captured at 390 and 1440 px (see
  [`02-ui-review.md`](02-ui-review.md)); the permission-request state, the error
  line and the limit notice are covered by jsdom, not by pixels.

## E2E

`apps/web/e2e/dictation.spec.ts` runs one Chromium test against real browser
capture, with no page-level doubles:

- `apps/web/e2e/fake-stt.ts` is a Whisper-compatible stub on `127.0.0.1:8899`:
  `GET /healthz` answers `{"ok":true}` and `POST /audio/transcriptions` reads
  and discards the multipart body, then answers
  `{"text":"Diktat aus dem Browser."}`. Every other path is 404; bodies are
  never logged. Playwright starts it as a third `webServer` (its own port, no
  reuse), and the BFF runs with `STT_URL=http://127.0.0.1:8899`, so `/api/info`
  advertises dictation. It runs as `node e2e/fake-stt.ts`: `tsx` is not a
  dependency of `@openchat/web`, and Node ≥ 24 strips the types of this
  erasable-syntax file itself.
- Chromium launches with `--use-fake-device-for-media-stream` and
  `--use-fake-ui-for-media-stream`; the browser context also grants
  `microphone`. The real `MediaRecorder` therefore records `audio/webm` chunks
  from the fake device without an OS microphone or a permission prompt.

The test proves:

- the mic button appears only because `/api/info` reports `dictation.enabled`;
- a press starts real capture, the recording pill shows, and its `m:ss` clock
  advances;
- stopping sends exactly one `POST /api/transcribe`; the fake transcript is
  inserted at the caret in the draft, the busy line clears, and the transcript
  still holds no `message-user`/`message-assistant` — dictation inserts, it
  never sends;
- Escape during a second recording cancels it: no further `/api/transcribe`
  request and the draft is unchanged;
- the external-request guard stays empty.

It deliberately does not cover: a physical microphone or the permission
prompt, real Whisper output, quality or latency, the BFF's timeout and size
caps (server tests), Safari/iOS `audio/mp4`, or the pill's pixels (not in the
UI-review manifest).


## Screenshots

`apps/web/playwright.screenshots.config.ts` boots the same fake STT service and
passes `STT_URL` to the BFF, so the UI-review capture set shows the real
configured state. The `chat-empty` route carries a `start-dictation` variant
(`{ name: "recording" }`): the harness clicks the mic, waits for the pill and
lets the clock reach `0:01` before capturing. Result: two new PNGs,
`ui-review/empty/{desktop,mobile}/chat-empty-recording-sec0.png`, and the mic
now appears in every authenticated capture. See
[`02-ui-review.md`](02-ui-review.md) for the reviewed states and the findings.
