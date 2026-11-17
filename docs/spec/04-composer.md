# 04 — Composer

## Elements

- Auto-growing multiline text field.
- Send button; changes to stop while a run is active.
- Attachment button (file picker).
- Tool menu: web search, code execution, browser, image generation — only
  entries that the active agent/model supports.
- Model selector.
- Agent selector.
- Optional skill selector.
- Attachment chips with name, size, type, remove and upload state.
- Character/token hint and limit warnings.

A dictation button is **V2** (FR-34 … FR-36); v1 ships no microphone control.

## Input behavior

- `Enter` sends; `Shift+Enter` inserts a newline.
- `Ctrl/Cmd+Enter` also sends.
- `Escape` closes the tool/model menu; a second `Escape` blurs the field.
- IME composition must not send on Enter.
- Drafts persist per session and survive reload.
- The field grows to a maximum height, then scrolls.
- Pasted text longer than 20 000 characters collapses into an attachment chip.

## Attachments

Supported:

- UTF-8 text files (decoded text)
- directories (non-recursive listing) — desktop only
- PNG, JPEG, GIF, WebP (image input models only)
- PDF (PDF input models only)
- SVG is treated as text

Limits:

- 20 MiB per attachment, enforced client- and server-side.
- Unsupported binary types are rejected with a specific message.
- Images may be resized by OpenCode according to `media.image` settings.

Interactions:

- Picker, drag/drop and paste.
- Upload on send, not on selection, unless the backend needs a pre-upload.
- Show each attachment as a removable chip with name, size and type icon.
- Upload progress and cancel.
- Remove before send.
- Clear error per file; one bad file does not discard the prompt.
- A failed upload keeps the draft and offers a retry; it never silently drops
  the file.
- Images and PDFs are passed as OpenCode file parts; do not inline large
  binaries into the transcript.

## Model and effort selection

Observed (OBS-014):

- The composer shows a compact trigger labelled with the reasoning effort
  ("High"), not the model name.
- The popover opens above the composer and contains:
  - a title row,
  - a discrete 3-step effort slider with a status line ("High, 3 of 3"),
  - a "Choose model" row,
  - a "Performance" row,
  - a radio list of available models with the current one checked.
- Effort is a small enum, not a free number.

Our implementation:

- Effort values map to the model/provider capability; hide the slider when the
  model does not support reasoning effort.
- The model list comes from `model.list()`; unavailable models are disabled
  with a reason.
- Selection is stored on the session (`session.switchModel`,
  `session.switchAgent`) and survives reload.
- Changing model or effort affects the next prompt, never the transcript.

## Composer growth

Observed (OBS-018): with multi-paragraph input the composer grows and adds an
"Expand" control; the action row stays at the bottom.

Our implementation:

- Grow to a maximum height (8 lines), then scroll.
- Offer an expanded editor overlay for long input.
- Keep send/stop, attachments and model trigger reachable at every height.

## Mode switch

The reference shows a Chat/Work switch in the header and shrinks it below
640 px (OBS-013, OBS-035). The Work surface is out of scope and the owner
excluded it, so **v1 renders no switch at all** — not a disabled or hidden
one.

## Dictation — V2

Dictation is a V2 input method, not part of v1. It turns speech into composer
text and never sends the prompt.

- The microphone button starts recording only after an explicit click or key
  press; the app requests the microphone permission at that moment, never on
  page load.
- Two gestures: hold to talk, or click to toggle hands-free recording. A
  recording pill shows elapsed time, a level meter, stop and cancel.
- Cancel discards the audio and inserts nothing. Stop ends capture and starts
  transcription; the button shows a busy state.
- The transcript is inserted at the caret as normal editable text in the
  current UI language. The owner can correct it before sending.
- Default limit: 2 minutes or 25 MiB, whichever comes first; both are
  configurable. Reaching the limit stops capture and transcribes what exists.
- Capture happens on the device. The browser sends the audio to the same-origin
  BFF (`POST /api/transcribe`), which forwards it to the configured
  Whisper-compatible STT service. Nothing is sent to a third party unless the
  owner configured one.
- The BFF streams the audio through and does not write it to disk; only the
  resulting text is kept in the draft. No audio in logs.
- Optional live partial text when the STT service supports streaming;
  otherwise show "Transcribing…" and insert once.
- Errors are specific and recoverable: permission denied (with browser
  instructions), no input device, unsupported MIME type, service unavailable,
  timeout, empty transcript. A failed transcription keeps the draft and offers
  retry; it never silently drops text.
- The feature is absent when `STT_URL` is unset. There is no fake "listening"
  state without a working service.
- Keyboard: the microphone button is focusable and toggles with `Enter` or
  `Space`; `Escape` cancels recording before it closes any menu.

Implementation notes:

- Prefer `MediaRecorder` with `audio/webm;codecs=opus` where supported and
  `audio/mp4` on Safari; do not assume one MIME type.
- Recording must survive a route change within the session or be cancelled
  explicitly; do not leave the microphone open.
- iOS Safari requires the recording start inside the user gesture.

## Mobile composer

Observed (OBS-028, OBS-035): the composer is two rows below 640 px — text field
on top, plus/effort/mic/voice below — with a 16 px side inset and a ~28 px
radius. At 640 px it is a single row with ~32 px insets.

Our implementation:

- Keep the action row below the field on narrow widths; never shrink icon
  buttons below 36 px, and raise the touch target to 44 px via padding.
- The send/stop button stays at the bottom right and is always reachable.
- Attachments open a sheet rather than a popover.
- The scroll-to-bottom control sits above the composer, not over the field.

## Add menu

Observed (OBS-036): the plus button expands an inline panel above the composer,
768 px wide and up to 378 px high, radius 20, 1 px border, 8 px padding, an
inner scroll area and 36 px rows (radius 12, padding 6 × 8) with a 14 px label
and a muted description. The first row is highlighted; the panel scrolls
independently of the page.

Our implementation:

- The first action is **Add files**, which opens the file picker and accepts
  drag/drop and paste.
- Further rows appear only for shipped features: web search, image generation,
  deep research. Each row has a label and a one-line description.
- No row is a dead placeholder; a section is absent when the backend cannot
  serve it.
- The panel closes on Escape, on outside click and after an action; focus
  returns to the plus button.
- On mobile the same actions open a bottom sheet.

## Tool menu

- Entries reflect actual availability (MCP status, provider support).
- Selecting a tool inserts a hint or enables a mode; it does not fake a call.
- Permission-requiring tools show a lock icon and the current rule.

## Accessibility

- The field has a visible label or an accessible name.
- Attachment chips are reachable by keyboard and removable with `Delete`.
- The send button has an accessible name that reflects the state.
- Errors are announced via a live region.

## Open questions

- `OPEN:` Does the reference use a single composer toolbar or a nested menu?
- `OPEN:` Which keyboard shortcuts does the reference expose? Verify before
  matching them.
- `OPEN:` Is there a separate "temporary chat" mode? If yes, is it in scope?
