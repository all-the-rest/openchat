# 07 — Settings and Auth

## Auth model

- Exactly one user.
- Credentials come from environment variables (`AUTH_USER`,
  `AUTH_PASSWORD_HASH`, `AUTH_SECRET`).
- No registration, no password reset by email, no OAuth in v1.
- Login form sets a signed, HttpOnly, SameSite=Lax session cookie.
- Session TTL is configurable; logout clears the cookie.
- Optional edge Basic Auth (Caddy) in front of the app as a second layer.
- OpenCode itself is never exposed; the BFF authenticates every request.

## Login screen

- Minimal: product name, username, password, submit.
- Error messages do not reveal whether the username or password was wrong.
- Rate limit: exponential backoff per IP and per username.
- After login, redirect to the originally requested route.
- Logout is available in the profile menu.

## Settings sections

### Models

- List providers and models from OpenCode.
- Show context window, capabilities (reasoning, image input, PDF input), cost.
- Set the default model for new chats.
- Deep link to the OpenCode web UI for provider credentials and custom models.

### Agents

- List agents, their mode and model.
- Set the default agent.
- Show the effective permission rules (read-only).
- Deep link to OpenCode for advanced agent configuration.

### Connectors

- List MCP servers and status (`connected`, `pending`, `needs auth`, `failed`,
  `disabled`).
- Show tools per server.
- Connect/disconnect where the API supports it.
- Deep link to the OpenCode web UI for OAuth and configuration.

### Appearance

- Theme: system, light, dark.
- Language: English, German.
- Density: comfortable, compact.
- Reduced motion toggle.
- Font size.

### Data

- Export a session (JSON/Markdown).
- Delete a session or all data (with confirmation).
- Show storage locations and backup hints.
- No telemetry by default.

### Advanced

- OpenCode server status: version, URL, latency.
- Link to the OpenCode web UI.
- Show the effective configuration path.
- Diagnostics: recent errors, event stream status.

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

## Security requirements

- Cookie: `HttpOnly`, `Secure` in production, `SameSite=Lax`, signed.
- CSRF: same-site cookie plus origin check for state-changing requests.
- No credentials in localStorage.
- No secrets in client bundles.
- Login and API rate limiting.
- Audit log of logins and permission approvals (no prompt content).
