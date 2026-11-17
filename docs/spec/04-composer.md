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
- Upload progress and cancel.
- Remove before send.
- Clear error per file; one bad file does not discard the prompt.

## Model and agent selection

- The list comes from `GET /api/model` and `GET /api/agent`.
- Show provider, model name, context window, reasoning capability and image/PDF
  input capability.
- Unavailable models are hidden or disabled with a reason.
- Selection is stored on the session (`session.switchModel`,
  `session.switchAgent`).
- Changing the model mid-session affects the next prompt, not the transcript.

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
