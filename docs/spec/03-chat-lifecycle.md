# 03 — Chat Lifecycle

## State machine

```
idle → submitting → streaming → (tool_wait | permission_wait | form_wait) → streaming
     → completed | stopped | failed
```

- `submitting`: optimistic user message is shown; the prompt request is in
  flight.
- `streaming`: text/reasoning deltas arrive.
- `tool_wait`: a tool is running; the composer stays enabled for steering unless
  the agent is blocking.
- `permission_wait`: the agent needs approval; the run is paused.
- `form_wait`: the agent asks a structured question.
- `completed`: finish reason received.
- `stopped`: user interrupted.
- `failed`: structured error received or transport failed.

Only one active run per session in v1. A second send while running either
queues (inbox) or is rejected with a clear message. Choose queueing if OpenCode
exposes an inbox; otherwise reject.

## Send flow

1. If no session exists, create one with the selected location (project
   directory), agent and model.
2. Append the user message locally with a client-generated ID.
3. Submit `text`, `files`, `agents`, `skills` to OpenCode.
4. Subscribe to events if not already subscribed.
5. Fold deltas into the message by message ID and part ordinal.
6. On tool events, create/update tool cards.
7. On permission events, show a blocking card.
8. On completion, reconcile the local message with the server message.
9. Persist the draft state and scroll position.

## Event folding

- Text deltas append to the matching text part.
- Reasoning deltas append to the reasoning part.
- Tool input deltas append to the matching tool call.
- Message snapshots replace local state; they are authoritative.
- Unknown event types are ignored but counted in diagnostics.
- Duplicate events are idempotent by event ID/sequence.

## Stop

- Show a stop button while `submitting` or `streaming`.
- Stop calls `session.interrupt`.
- Keep the partial response, mark it `stopped`, and allow "continue".
- Do not delete the session.

## Retry

- Retry the last assistant turn without duplicating the user message.
- If the provider failed before any token, retry is safe.
- If the provider failed mid-stream, offer "retry" and "continue" as separate
  actions.

## Edit and branch

- Editing a user message creates a new branch from that point.
- The old branch remains reachable.
- Branch navigation is available in the message actions.
- The session title does not change automatically.

## Compaction

- When OpenCode compacts, show a system notice in the thread.
- Keep pre-compaction messages visible but mark the boundary.
- Do not silently drop messages from the UI.

## Errors

| Error | UI |
| --- | --- |
| Auth/session expired | Re-login prompt; preserve draft |
| Provider error | Error card with provider message and retry |
| Rate limit | Countdown if provided; retry disabled until then |
| Tool error | Tool card with error and "retry tool" if supported |
| Network lost | Banner; attempt reconnect; preserve state |
| Context overflow | Offer compaction/continue |
| Permission denied | Explain and allow the user to change the rule |

## Acceptance

- A prompt streams from first token to completion without layout jumps.
- Stop leaves a usable partial answer.
- A page reload during streaming restores the server state.
- A permission request blocks the run and resumes after approval.
- A failed run never loses the user's prompt or attachments.
