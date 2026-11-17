# ADR 0006 — Compile Interactive Apps at Write Time

**Status:** accepted for V2 (2026-11-17)
**Deciders:** owner, orchestrator

## Context

FR-37 … FR-40 require interactive HTML/CSS/JS apps: calculators, charts,
simulations, small tools, with reset/present/download and a validated result
bridge. The owner wants "beautiful interactive apps", ideally small React or
SolidJS apps, served inside our UI.

The artifact sandbox must stay offline, cookie-less and script-only. The
artifact host is a read-only byte server with no network and no build tooling;
the artifact store is OpenCode's `experimental.artifacts` static provider.

Candidates:

| Option | Result |
| --- | --- |
| Model writes plain HTML in chat | Unenforceable; CDN links, truncation and broken apps reach the user |
| Model writes JSX, browser compiles it | Needs `unsafe-eval` and large tools; slow on mobile |
| Import map to host-served modules | Requires `script-src 'self'`, which exposes every artifact-origin path and breaks the portable download |
| Solid runtime tag (`solid-js/html`) | Confirmed `new Function` in the runtime; needs `unsafe-eval` |
| esbuild-wasm in the frame | ~10 MB WASM, no storage, `wasm-unsafe-eval` |
| Compile in the tool, store one HTML file | Small, deterministic, offline, no eval |

## Decision

1. A **tool** (`openchat_app_write`) is the only way to create an interactive
   app. It validates, compiles and stores; errors return into the turn.
2. The model writes **one Preact JSX component**. `Bun.build` turns it into an
   IIFE with Preact and hooks injected. No imports, no network, no eval.
3. The tool assembles a **single portable HTML document** (`data-oc="1"`,
   `#root`, bridge shim) and stores it via the BFF and OpenCode's artifact API.
4. Runtime injection happens at **write time**, never at serve time. The
   artifact host stays a read-only byte server; preview and download are
   byte-identical.
5. The artifact CSP drops `'unsafe-eval'`. It keeps `default-src 'none'`,
   `connect-src 'none'` and no `'self'`.

## Consequences

- Apps are offline and deterministic, and the sandbox gains no new capability.
- Reset is a re-mount inside the frame; no new signed URL is needed.
- The bundle is small (~5.4 KiB gzipped for Preact + a small app, ~20 ms build).
- Preact is the supported framework. Solid or real React would need a
  build-time transform the runtime cannot provide without eval or a bundler;
  they are out of scope until a concrete need appears.
- Runtime fixes require re-rendering stored artifacts in a migration, not a
  serve-time rewrite.
- The MCP tool runs where OpenCode runs, so a remote OpenCode host needs an
  explicit BFF URL or the degraded workspace mode.
- Determinism depends on the pinned Bun version; snapshot tests assert it.

## Alternatives rejected

- Solid, React without Preact, or import maps — CSP cost, size or portability.
- Browser-side compilation — `unsafe-eval`, size, mobile latency.
- Serve-time rewriting — the artifact host has no network or build tooling, and
  preview would diverge from download.
