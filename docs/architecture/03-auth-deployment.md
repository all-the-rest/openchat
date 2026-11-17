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
- The artifact host is a separate hostname, cookie-less, and reachable only with
  signed, short-lived URLs and its own CSP.
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
# Optional upstream credential if OpenCode sits behind Basic auth.
OPENCODE_AUTH=
WORKSPACE_DIR=/workspace
ARTIFACT_HOST_URL=https://artifacts.example.com
ARTIFACT_SIGNING_KEY=...     # 32+ random bytes, HMAC for artifact URLs
ADMIN_PROXY=off              # on: BFF proxies /admin/opencode behind auth
```

`OPENCODE_TOKEN` is deliberately absent: OpenCode does not authenticate HTTP
requests in 2.3 unless the deployment puts a credential in front of it. Its
protection is the network — loopback in development, a private Docker network
with no published port in production. If a deployment needs request-level auth,
terminate it in the BFF proxy and keep the OpenCode listener private.

## Production pattern (owner's existing edge)

The owner already runs OpenCode behind Caddy. That is the target shape for this
project; it is documented here so the deployment does not reinvent it, and it is
**not** implemented in M1.

```
browser ──TLS──▶ Caddy ──forward_auth──▶ auth sidecar (HMAC cookie)
                    │                        │
                    │◀── 401 → /login.html ──┘
                    │
                    └── reverse_proxy ──▶ OpenCode (private, Basic upstream)
```

Properties worth keeping:

- A small auth sidecar validates the session cookie via `forward_auth`; the
  browser never reaches OpenCode without a valid cookie.
- Caddy injects the OpenCode Basic credential upstream (`header_up
  Authorization "Basic …"`), so the browser never sees it. The edge credential
  and the upstream credential rotate independently.
- `/login`, `/logout` and `/api/me` are explicit handles above the catch-all.
- `health_uri /api/info` with the same injected credential marks a dead upstream
  unhealthy and serves an offline page.
- SSE needs no special flush configuration in Caddy; long response times are
  covered by `stream_timeout`.

Difference for this app: the BFF, not the browser, talks to OpenCode. The BFF is
the only component that needs the upstream credential, and it holds it
server-side (`OPENCODE_URL` + optional Basic header). The artifact origin stays
credential-free and is addressed only through signed URLs.

**Status:** reference pattern only. Verify the exact credential mechanism against
the pinned OpenCode version before wiring it.

Generate:

```bash
openssl rand -base64 32                 # AUTH_SECRET
openssl rand -base64 32                 # ARTIFACT_SIGNING_KEY
caddy hash-password --plaintext '...'   # AUTH_PASSWORD_HASH
```

## OpenCode administration

Provider keys, custom models, MCP servers and OAuth are configured in OpenCode,
not reimplemented in our UI. There are three supported ways to reach that
configuration, in order of preference:

1. **Local only:** run `opencode` on the host or over SSH. Nothing is exposed.
2. **Same-origin admin proxy:** the BFF serves `/admin/opencode/*` behind the
   same session cookie and forwards only the configuration endpoints. The
   OpenCode port stays unpublished.
3. **No public subdomain.** An `opencode.example.com` host is not supported: it
   would publish a shell-capable backend and break NFR-02.

The app links to `/admin/opencode` only when `ADMIN_PROXY=on`. With the proxy
off, the settings page says "configure OpenCode on the host" and shows no link.

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
    X-Frame-Options "DENY"
    Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-src https://artifacts.example.com; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
  }
  reverse_proxy app:3000
}

artifacts.example.com {
  header {
    Content-Security-Policy "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors https://chat.example.com"
    X-Content-Type-Options "nosniff"
    Referrer-Policy "no-referrer"
    Cache-Control "no-store"
  }
  reverse_proxy artifacts:3001
}
```

The artifact origin has **no authentication**: it serves only signed, short-lived
URLs (`?exp=…&sig=…`, HMAC with `ARTIFACT_SIGNING_KEY`). Adding Basic Auth would
break the cross-origin iframe and contradict the "no credentials" rule.

`img-src` deliberately omits `https:`. With any remote image source an artifact
can exfiltrate data through `new Image().src`. Remote images are proxied by the
artifact host if a use case requires them.

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

## Feature flags

Some capabilities sit behind `experimental.*` configuration keys. The 2.3 OpenAPI
documents only `experimental.mcp.event` in its schema; artifact, automation and
todo flags mentioned elsewhere are **not** confirmed by the API document. Before
a feature ships:

1. Check the pinned OpenCode config schema for the exact flag name.
2. Enable it in `opencode.json` on the OpenCode volume, never in the browser.
3. Record the flag in this document and in the feasibility matrix row.

No flag is enabled by default. A feature whose flag is absent hides its UI
instead of failing at runtime.

## Deployment sketch

```yaml
services:
  caddy:
    image: caddy:2
    ports: ["80:80", "443:443"]
    volumes: ["./Caddyfile:/etc/caddy/Caddyfile:ro", "caddy-data:/data"]
    networks: [frontend]
    depends_on: [app, artifacts]

  app:
    build: ./apps/server
    environment:
      AUTH_MODE: session
      AUTH_USER: ${AUTH_USER}
      AUTH_PASSWORD_HASH: ${AUTH_PASSWORD_HASH}
      AUTH_SECRET: ${AUTH_SECRET}
      SESSION_TTL: ${SESSION_TTL:-604800}
      ORIGIN: https://chat.example.com
      OPENCODE_URL: http://opencode:4096
      WORKSPACE_DIR: /workspace
      ARTIFACT_HOST_URL: https://artifacts.example.com
      ARTIFACT_SIGNING_KEY: ${ARTIFACT_SIGNING_KEY}
      ADMIN_PROXY: "off"
    networks: [frontend, backend]
    depends_on: [opencode]

  artifacts:
    build: ./apps/artifact-host
    environment:
      ARTIFACT_SIGNING_KEY: ${ARTIFACT_SIGNING_KEY}
    read_only: true
    networks: [frontend]

  opencode:
    image: ${OPENCODE_IMAGE:?pin a verified image tag}
    command: ["opencode", "serve", "--hostname", "0.0.0.0", "--port", "4096"]
    volumes:
      - opencode-data:/root/.local/share/opencode
      - opencode-config:/root/.config/opencode
      - workspace:/workspace
    networks: [backend]
    # no published ports: reachable only from the BFF

networks:
  frontend:
  backend:

volumes:
  caddy-data:
  opencode-data:
  opencode-config:
  workspace:
```

The image name is intentionally not hard-coded: verify the published OpenCode
image (or build it) and pin a digest before deploying. The BFF reaches OpenCode
only over the private `backend` network; `ADMIN_PROXY` (same-origin
`/admin/opencode`) stays `off` unless the owner enables it.

The artifact host shares the `frontend` network with Caddy and the app but has
no route to `opencode`; it holds no provider keys and no session secret.

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
