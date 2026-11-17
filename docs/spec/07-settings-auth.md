# 07 — Settings and Auth

## Auth model

- Exactly one user.
- Credentials come from environment variables: `OPENCHAT_USER` (the
  username embedded in the session), `OPENCHAT_PASSWORD` (the single
  credential) and `SESSION_SECRET` (signs the cookie). There is no password
  hash and no separate username field in the login form.
- No registration, no password reset by email, no OAuth in v1.
- Login form sets a signed, HttpOnly, SameSite=Lax session cookie. The cookie
  has a fixed lifetime (`SESSION_TTL_SECONDS`); there is no sliding renewal.
- Session TTL is configurable; logout clears the cookie.
- Optional edge Basic Auth (Caddy) in front of the app as a second layer.
- OpenCode itself is never exposed; the BFF authenticates every request.

## Login screen

- Minimal: product name, password, submit.
- One generic error message; it never reveals whether the username or password
  was wrong (there is only one password).
- Rate limit: fixed window of 10 failed attempts per client address in 60
  seconds. Requests over the limit answer `429` with `Retry-After`. A
  successful login clears the window.
- Prompt submission has its own cheap fixed window: 30 prompts per address in
  60 seconds, also `429` with `Retry-After`. Interrupt and inbox reads stay
  outside that budget.
- After login, redirect to the originally requested route.
- Logout is available in the app menu.

## Settings sections

This is a self-hosted single-user product, not a hosted account. Settings are a
secondary surface, and v1 needs far fewer of them than the reference. The
reference settings tree (account, billing, parental controls, pets, usage
plans) is recorded as observation only and is **not** a requirement.

M1 ships only the language switch (persisted locally) and a read-only server
status; both live on a minimal `/settings` route. Everything else follows with
the feature it configures, from M3 onward.

### Models

- List providers and models from OpenCode.
- Show context window, capabilities (reasoning, image input, PDF input), cost.
- Set the default model for new chats.
- Provider credentials and custom models are configured in OpenCode; the page
  shows the configuration path, or the Code surface (V2) / config-only admin
  route (`ADMIN_PROXY=on`) when enabled.

### Agents

- List agents, their mode and model.
- Set the default agent.
- Show the effective permission rules (read-only).
- Advanced agent configuration stays in OpenCode files.

### Connectors

- List MCP servers and status (`connected`, `pending`, `needs auth`, `failed`,
  `disabled`).
- Show tools per server.
- Connect/disconnect where the API supports it.
- OAuth and server configuration stay in OpenCode, reachable through the
  same-origin admin route when enabled.

### Appearance

- Theme: system, light, dark.
- Language: English, German.
- Reduced motion toggle.
- No arbitrary accent, font or per-theme editing in v1; that is reference
  behavior and adds configuration surface without a single-user benefit.

### Data

- Export a session (JSON/Markdown).
- Delete a session or all data (with confirmation).
- Show storage locations and backup hints.
- No telemetry by default.

### Server

- OpenCode version, URL and latency.
- Event stream status and the last error.
- Effective configuration path.
- The same-origin admin route when `ADMIN_PROXY=on`; otherwise a text
  instruction to configure OpenCode on the host.

### Explicitly not in scope

Account profile, display name, email and username, password reset by email,
plan/billing, parental controls, trust contacts, "pets", usage quotas and
marketing preferences. None of them exists in a single-user self-hosted
deployment; rendering them would be decoration without a backend.

## OpenCode configuration flow

The app owns chat UX, not provider setup. For provider keys, OAuth, custom
models and MCP configuration:

1. User opens Settings → Connectors/Models.
2. Clicks "Open OpenCode settings" (only shown when `ADMIN_PROXY=on`).
3. The BFF serves `/admin/opencode/*` on the **same origin**, behind the same
   session cookie, and forwards only configuration endpoints.
4. After saving, the app refreshes config/models via the API.

With `ADMIN_PROXY=off` the settings page shows the configuration path and says
"configure OpenCode on the host"; there is no link.

Never publish the OpenCode port or a separate `opencode.` subdomain. A public
OpenCode host would expose a shell-capable backend and break NFR-02. This
avoids reimplementing provider management while keeping one source of truth.

## M7 deployment (not implemented)

The M1/M2 auth model is one password compared in constant time. The following
hardening is deliberately deferred to the M7 deployment milestone and is **not
implemented** today; do not configure these variables yet:

- A separate username field and hashed credentials (`AUTH_USER`,
  `AUTH_PASSWORD_HASH` with bcrypt/argon2).
- Exponential backoff per address and per username. The current throttle is a
  fixed window of 10 failures per address in 60 seconds.
- Sliding session renewal at most once per hour. The current cookie has a fixed
  absolute lifetime.
- A server-side session record that logout can revoke. Logout currently clears
  the cookie only.

## Security requirements

- Cookie: `HttpOnly`, `Secure` in production, `SameSite=Lax`, signed.
- CSRF: same-site cookie plus origin check for state-changing requests.
- No credentials in localStorage.
- No secrets in client bundles.
- Login and API rate limiting.
- Audit log of logins and permission approvals (no prompt content).
