# 10 — Acceptance

End-to-end scenarios. Each scenario is a Playwright test candidate.

## A. Auth

**Given** the app runs with `AUTH_MODE=session`
**When** an unauthenticated user opens `/`
**Then** the login form is shown
**And** no API call to OpenCode is made.

**Given** the app runs with `AUTH_MODE=basic`
**When** an unauthenticated user opens `/`
**Then** the edge asks for credentials and no page is served without them.

**When** the user logs in with valid credentials
**Then** a session cookie is set
**And** the user lands on the requested route.

**When** the user logs out
**Then** the cookie is cleared and protected routes redirect to `/login`.

## B. New chat and streaming

**Given** a logged-in user and a configured model
**When** the user sends "Hello"
**Then** a session is created
**And** the user message appears immediately
**And** assistant text streams incrementally
**And** the final message is persisted.

**Given** a streaming response
**When** the user sends a second prompt
**Then** it is queued (`delivery: "queue"`) and shown as pending
**And** it starts when the active run completes.

## C. Stop and retry

**Given** a streaming response
**When** the user presses stop
**Then** the stream ends
**And** the partial answer remains
**And** "continue" and "retry" are available.

## D. Tool call

**Given** an agent that uses a tool
**When** the tool runs
**Then** a tool card shows name, status and duration
**And** the output can be expanded
**And** an error is shown in the card without breaking the thread.

## E. Permission

**Given** a tool requires approval
**When** the permission request arrives
**Then** a blocking card shows action and resource
**And** the run pauses
**When** the user allows once
**Then** the tool runs and the thread continues.

## F. Attachments

**Given** a text file, an image and a PDF
**When** each is attached and sent
**Then** the attachment is uploaded/encoded correctly
**And** unsupported or oversized files are rejected with a clear message.

## G. Rendering

**Given** an assistant message containing Markdown, a table, code, math, a
Mermaid diagram, an image and a citation
**When** it renders
**Then** each part uses its renderer
**And** no raw HTML executes on the app origin.

## H. Artifact

**Given** an artifact with HTML and JavaScript
**When** it is opened
**Then** it renders in the sandboxed iframe on the artifact origin
**And** it cannot read app cookies or call the app API
**And** it cannot open a popup or navigate the top window
**And** an attempt to navigate its own frame to an external host is dropped by
the artifact container's egress policy.

**Given** an interactive artifact (V2)
**When** the user changes an input
**Then** it recomputes without a reload
**And** reset restores the initial state
**And** a `postMessage` result becomes a draft, not executed HTML.

## I. Agents and tasks

**Given** an agent that creates a schedule
**When** the run completes
**Then** the task appears under `/tasks`
**And** pause/resume works.

**Given** the todo spike is not shipped
**Then** no empty todo panel is rendered and a plan is shown as a tool card or
Markdown list instead.

## J. Models and settings

**Given** multiple models and agents
**When** the user switches model and agent
**Then** the next prompt uses the new selection
**And** the setting survives a reload.

## K. Language and theme

**Given** the UI language is English
**When** the user switches to German
**Then** all UI strings change without reload
**And** the document `lang` attribute becomes `de`
**And** the choice persists.

**Given** the source tree
**When** `bun run lint` runs
**Then** a hard-coded user-visible string fails the build
**And** a key missing from either locale fails the build.

## L. Security

- Direct unauthenticated access to the OpenCode port fails with 401, even on
  loopback.
- API calls without a session cookie return 401.
- CSRF origin checks reject cross-origin state changes.
- Artifact iframe has no `allow-same-origin`, `allow-popups` or `allow-modals`.
- The Code surface (V2) only loads with a valid single-use ticket; a replayed
  ticket is rejected.
- No secrets appear in the client bundle or logs.

## M. Recovery

**Given** the backend restarts during a run
**When** the UI reconnects
**Then** the session state is restored from the server
**And** the user sees a clear notice.

## N. Zero-quota tests

**Given** a CI environment with no provider credentials and no network access
**When** `bun run test` and the Playwright suite run
**Then** every scenario above runs against `BACKEND_MODE=fake`
**And** no request reaches a provider or a real OpenCode server
**And** the live smoke is skipped unless `LIVE_TESTS=1`.

**Given** `BACKEND_MODE=fake` and `NODE_ENV=production`
**When** the server starts
**Then** it refuses to start.

## Definition of done

- All scenarios pass in CI against the fake backend (or are explicitly marked
  manual).
- `bun run lint`, `bun run typecheck`, `bun run test`, `bun run build` pass.
- No scenario in the default suite contacts a real provider.
- Accessibility pass has no serious axe findings.
- Every new user-visible string has an `en` and a `de` translation.
- No secrets, no raw reference material and no personal data in the change.
