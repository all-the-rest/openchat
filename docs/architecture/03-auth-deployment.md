# 03 — Auth and Deployment

## Threat model

The app controls an agent that can run shell commands, read files and browse the
web. Anyone who reaches the API can therefore execute code on the host. Auth is
the primary security boundary, not a UX feature.

Assumptions:

- One trusted owner.
- The app is reachable from the public internet.
- OpenCode, the workspace and provider keys live on the same host.
- Agent output is untrusted.
- The browser is trusted but may be on an untrusted network.

## Network layout

```
Internet
  │ HTTPS
  ▼
Caddy (TLS, optional Basic Auth, rate limit, security headers)
  │ private network
  ├── app:3000            BFF + static UI
  ├── artifacts:3001      sandbox origin (separate hostname)
  └── opencode:4096       internal only, never published
        │
        ├── model providers
        ├── MCP servers (browse, rea, …)
        └── workspace volume
```

Rules:

- OpenCode has **no public port** and no host port binding in production.
- The BFF is the only public application port.
- The artifact host is a separate hostname with its own auth and CSP.
- Docker networks isolate services; only Caddy joins the public network.

## Auth modes

### Mode `basic` (prototype)

Caddy terminates HTTP Basic Auth for the whole site. The BFF trusts that it is
only reachable through Caddy. Suitable for a quick single-user prototype.

- Pros: minimal code, no login form, no session store.
- Cons: browser Basic Auth UX, no logout, credentials cached by the browser,
  every request carries the password.

### Mode `session` (recommended)

The BFF serves a login form and sets a signed session cookie. Caddy may add Basic
Auth as a second layer.

- Pros: logout, TTL, rate limiting, better UX, no password on every request.
- Cons: a little more code and a session secret.

### Recommendation

Start with `AUTH_MODE=basic` for the first prototype, then switch to `session`
before exposing it beyond a trusted network. Both share the same credential
source and can run together.

## Configuration

```env
AUTH_MODE=session            # basic | session
AUTH_USER=owner
AUTH_PASSWORD_HASH=...       # bcrypt/argon2
AUTH_SECRET=...              # 32+ random bytes, base64
SESSION_TTL=604800           # 7 days
ORIGIN=https://chat.example.com
OPENCODE_URL=http://opencode:4096
OPENCODE_UI_URL=https://opencode.example.com
```

Generate:

```bash
openssl rand -base64 32                 # AUTH_SECRET
caddy hash-password --plaintext '...'   # AUTH_PASSWORD_HASH
```

## Caddy sketch

```caddyfile
chat.example.com {
  encode zstd gzip
  basic_auth {
    owner $2a$14$...
  }
  header {
    Strict-Transport-Security "max-age=31536000; includeSubDomains"
    X-Content-Type-Options "nosniff"
    Referrer-Policy "no-referrer"
    Permissions-Policy "camera=(), geolocation=(), microphone=(self)"
  }
  reverse_proxy app:3000
}

artifacts.example.com {
  basic_auth {
    owner $2a$14$...
  }
  header {
    Content-Security-Policy "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob: https:; font-src data:; connect-src 'none'; frame-ancestors https://chat.example.com"
  }
  reverse_proxy artifacts:3001
}
```

The app origin must send `X-Frame-Options: DENY` (or a CSP `frame-ancestors
'none'`) so the app itself cannot be framed.

## Session cookie

- `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`.
- Signed with `AUTH_SECRET`; rotate the secret to invalidate all sessions.
- TTL from `SESSION_TTL`; sliding renewal at most once per hour.
- Logout clears the cookie and the server-side session record.

## CSRF and abuse

- State-changing requests require `Origin`/`Sec-Fetch-Site` checks.
- SameSite=Lax plus a CSRF token for forms is defense in depth.
- Rate limit login attempts and prompt submission per IP.
- Cap request body size (attachments handled separately).
- Reject unknown content types.
- Do not expose stack traces.

## Secrets

- Provider keys and MCP credentials live in OpenCode configuration or its
  credential store, never in the browser.
- `.env` is `0600`, owned by the service user.
- Docker secrets or a secret manager for production.
- No secrets in images, git history or logs.
- Rotate `AUTH_SECRET` and the password after any suspected exposure.

## Deployment sketch

```yaml
services:
  caddy:
    image: caddy:2
    ports: ["80:80", "443:443"]
    volumes: ["./Caddyfile:/etc/caddy/Caddyfile:ro", "caddy-data:/data"]
    depends_on: [app, artifacts]

  app:
    build: ./apps/server
    environment:
      AUTH_MODE: session
      AUTH_USER: ${AUTH_USER}
      AUTH_PASSWORD_HASH: ${AUTH_PASSWORD_HASH}
      AUTH_SECRET: ${AUTH_SECRET}
      ORIGIN: https://chat.example.com
      OPENCODE_URL: http://opencode:4096
    depends_on: [opencode]

  artifacts:
    build: ./apps/artifact-host
    environment:
      ARTIFACT_SIGNING_KEY: ${ARTIFACT_SIGNING_KEY}
    read_only: true

  opencode:
    image: ghcr.io/anomalyco/opencode:2.3.0
    command: ["opencode", "serve", "--hostname", "0.0.0.0", "--port", "4096"]
    volumes:
      - opencode-data:/root/.local/share/opencode
      - opencode-config:/root/.config/opencode
      - workspace:/workspace
    # no ports: internal only

volumes:
  caddy-data:
  opencode-data:
  opencode-config:
  workspace:
```

Verify the official image name and command against the OpenCode docs before
using this snippet; pin a version and test the health endpoint.

## Operations

- **Health:** `/healthz` checks the BFF and OpenCode `/api/info`.
- **Backups:** OpenCode data, config, workspace and `.env`. Test a restore.
- **Updates:** pin versions, back up, update, run the smoke suite, keep the
  previous image tag.
- **Logs:** structured JSON, no prompt content, retention bounded.
- **Monitoring:** uptime, disk, error rate, stream disconnects.
- **Kill switch:** stop the `opencode` service to disable all agent execution
  without taking the UI down.
- **Incident:** rotate `AUTH_SECRET`, rotate the password, inspect audit logs,
  check for unexpected shell/network activity.

## Out of scope

Multi-user accounts, roles, OAuth, public sharing. The architecture leaves room
for them, but the security model would need a redesign.
