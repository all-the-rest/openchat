# 24 — Composer controls: models, agents, permissions, settings, retry

Issue #5, slice after #21 (uploads) and #23 (PWA). The composer itself is not
restructured: upload chips, paste/drop and attachment references stay owned by
#21. The new controls live in the chat header, above the composer and on the
settings route.

## Catalogue choices

- `GET /api/models` and `GET /api/agents` read the two existing backend
  catalogues through `ChatBackend.listModels` / `listAgents`. One failing
  catalogue does not hide the other: the browser hides a picker whose catalogue
  is empty or unreachable rather than rendering an empty list.
- The browser stores one JSON object under `openchat.completion`
  (`{ model, agent }`). There is no per-chat override: the same choice applies to
  every new prompt in the browser.
- `PromptRequest` and `PromptInput` carry optional `model` and `agent`. The
  BFF forwards both; the fake ignores them; the live adapter applies them with
  `session.switchModel` / `session.switchAgent` before `session.prompt` (the
  pinned 2.3.0 client has no `model`/`agent` on `session.prompt` itself).
  A model id absent from the cached catalogue is ignored, not guessed.

## Approvals

- `permission.asked` / `permission.replied` are mapped into the flat SSE
  contract. `PermissionRequest` carries `tool` (host action name), `action`
  (host message or resources) and `resources`; the decision is
  `once | always | deny`, mapped to the host's `once | always | reject`.
- `GET /api/sessions/:id/permissions` lists outstanding approvals;
  `POST /api/sessions/:id/permissions/:requestID` accepts only those three
  decisions (400 otherwise) and returns 404 for an unknown id.
- The card sits above the composer. Its three buttons are ordinary focusable
  buttons; while any request is outstanding the composer is disabled, so a
  prompt cannot be sent before the user answers. A `permission.replied` event
  removes the card; a denial adds a system note to the transcript.

## Settings and retry

`/settings` contains the persisted language, the same default model and agent
pickers, and a read-only status block from `/api/info` (version, host
reachability, dictation and documents availability). Every string is in the
`en`/`de` catalogues.

A failed assistant turn gets a retry action under the last assistant message.
It re-sends the text of the most recent user message as a new prompt; no part of
the failed turn is kept or reused.

## Deliberate omissions

- **Edit, branch and compaction notices** are not part of this slice.
- **Per-chat model/agent overrides** are not supported; the browser-wide
  default is the only choice.
- Structured approval forms beyond the three decisions are not implemented.

The fake-mode E2E hooks (`/api/__fake/prompt/:id`, `/api/__fake/permission`)
exist only when `BACKEND_MODE=fake`, next to the existing host outage switch.
They let a browser test assert what the host recorded and raise an approval
without a live tool-using agent.
