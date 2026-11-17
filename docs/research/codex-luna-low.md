# Codex in ChatGPT with "GPT-6 Luna" at Low Effort

**Status:** 2026-11-17. A single observed run in the Codex mode of the ChatGPT
web app, with the model set to GPT-6 Luna and the effort slider at the lowest
of five steps. Purpose: understand how a coding agent presents a task timeline
and file output in a chat surface, and what our chat core should imitate
structurally.

The run happened in the owner's own account with a throwaway prompt. No
reference markup or copy is reproduced; model names, labels and timings are
account- and time-dependent and are recorded as observations, not requirements.

## Setup

- Entry: the public Codex page → "try in the web" button opens the chat surface
  in Codex mode.
- Mode indicator in the header: "current mode: Codex".
- Composer controls, left to right: execution location, text field, add-files,
  permissions, model/effort picker, dictation, send.
- Execution location: cloud, standard environment.
- Model picker: GPT-6 Luna, effort "low, 1 of 5" (a five-step slider). The same
  menu has a model list, a "fast mode" checkbox and a reset-to-default action.
- Prompt: build a single self-contained `index.html` calculator with keyboard
  support, no external dependencies, and name the file.

## Timeline as observed

| State | What the message shows |
| --- | --- |
| accepted | user bubble; assistant placeholder with "chat is starting" |
| planning | "thinking" status line |
| executing | collapsible step chip "command is running", replaced the thinking line |
| done | "Duration: 1 min 18 s" disclosure above the answer |

The step chip is a disclosure: collapsed it is one line with a status word; it
is not a full tool card with input and output. There is no visible token
counter, no model badge inside the message, and no per-step timing.

## Output

- One line naming the created file.
- A file pill (`index.html`) that is a button, not inline code.
- A two-sentence summary, then the standard message actions (copy, rate, read
  aloud, share).
- The HTML itself is **not** rendered inline. There is no preview in the
  message; the file is an attachment in the turn, and the calculator becomes
  visible only after opening it.

## Timing

- End-to-end for a small single-file app: 1 min 18 s at the lowest effort step.
- The visible sequence (thinking → command running) covers most of that time;
  there is no progressive text streaming of the answer while the command runs.

## Viewing the generated app

Opening the file pill switches the surface to a **viewer** with its own header
(back/close, file name, download) — the chat hides and the app takes the content
column.

- The app runs in an iframe on `codex-inline-visualization-<id>.web-sandbox.oaiusercontent.com`
  with `sandbox="allow-scripts allow-same-origin"`, `title="index.html"`, and a
  query string carrying `app=skybridge`, locale, device type and
  `unsafeSkipTargetOriginCheck=true`.
- Inside that frame is a second, nested frame addressed as `about`; the actual
  document lives there.
- The calculator itself is one dark card: display, 20 buttons, a keyboard hint
  line. Every button has an accessible name ("7", "Mal", "Ergebnis", "Alles
  löschen"), so the low-effort output is usable with a screen reader.
- Verified interaction: `7 × 8 =` shows `56`; the keyboard hint claims digits,
  operators, `Enter` and `Escape`.
- Viewer chrome is limited to download and close; there is no reset, present or
  share action.

Security note for us: the reference grants `allow-scripts allow-same-origin`
together, which is the combination our artifact sandbox explicitly forbids
(spec 05, architecture 04/07). The origin is a per-app subdomain, which limits
the blast radius, but the frame can read its own origin's storage. Our design
keeps `allow-scripts` only, on a signed, cookie-less origin.

## What is worth keeping

1. **One duration disclosure per turn**, placed above the answer, collapsed by
   default. Cheap to render, immediately informative.
2. **Files as pills**, not as raw paths or fenced code. A pill is a button with
   a type icon and the file name.
3. **A step chip that collapses into a status line.** Our tool cards carry more
   (input, output, error) but should keep the one-line collapsed form.
4. **No chrome inside the message.** Model, effort and environment live in the
   composer; the message carries content and actions only.

## What not to copy

- No inline preview for a generated app. Our M4/V2 design renders artifacts in
  a sandboxed frame or the right rail, which is strictly better than download
  and open.
- The step chip hides the command text entirely when collapsed; our tool cards
  show the tool name and status, which is the minimum for trust.
- The assistant answer arrives in one block after the command, so there is no
  streaming feedback; our fake backend streams deltas and the UI must not
  regress to a spinner-only state.

## Caveats

- One run, one task, lowest effort. Latency at other effort steps is not
  measured.
- Model names and the effort slider are rolling account features; treat them as
  evidence for the pattern, not as constants.
- The run used a cloud environment; local execution was not exercised.
