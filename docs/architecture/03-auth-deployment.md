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
  ├── app:3000            BFF + static UI + /code switch
  ├── code:3002           authenticated OpenCode UI proxy (code.example.com)
  ├── artifacts:3001      sandbox origin (separate hostname)
  └── opencode:4096       internal only, Basic auth, never published
        │
        ├── model providers
        ├── MCP servers (browse, rea, …)
        └── workspace volume
```

Rules:

- OpenCode has **no public port** and no host port binding in production. Its
  HTTP API still requires Basic auth; the network is defense in depth.
- The BFF is the only public application port; the Code host is a second
  authenticated origin.
- The artifact host is a separate hostname, cookie-less, and reachable only with
  signed, short-lived URLs and its own CSP.
- Docker networks isolate services; only Caddy publishes ports to the host.

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
HOST=127.0.0.1               # container: 0.0.0.0
PORT=8787
TRUST_PROXY=0                # 1 behind a proxy that sets X-Forwarded-For
OPENCHAT_USER=owner
OPENCHAT_PASSWORD=...        # the only credential; hashing is M7
SESSION_SECRET=...           # 32+ random bytes, base64
SESSION_TTL_SECONDS=604800   # 7 days
COOKIE_SECURE=1              # required in production
ORIGIN=https://chat.example.com
OPENCODE_URL=http://opencode:4096
OPENCODE_USERNAME=opencode   # fixed by OpenCode 2.3
OPENCODE_PASSWORD=...        # Basic auth; required unless the server prints one
WORKSPACE_DIR=/workspace
ARTIFACT_HOST_URL=https://artifacts.example.com
ARTIFACT_SIGNING_KEY=...     # 32+ random bytes, HMAC for artifact URLs
ADMIN_PROXY=off              # on: BFF proxies /admin/opencode behind auth
STT_URL=                     # empty: dictation hidden
STT_API_KEY=                 # optional bearer token; never logged
DICTATION_MAX_SECONDS=120    # recording limit advertised to the composer
DICTATION_MAX_BYTES=26214400 # 25 MiB upload cap; clamped to 100 MiB
BACKEND_MODE=live            # live | fake
```

OpenCode 2.3 **does authenticate HTTP requests**. `opencode serve` requires
HTTP Basic auth with the fixed username `opencode`; the password comes from
`OPENCODE_PASSWORD` (alias: `OPENCODE_SERVER_PASSWORD`) or is generated and
printed once at startup. Without it the server answers `401` with
`WWW-Authenticate: Basic realm="Secure Area"`. The BFF therefore always sends
`Authorization: Basic base64("opencode:" + OPENCODE_PASSWORD)` and treats the
password as a required secret. Network isolation remains defense in depth, not
the only control. Verified against 2.3.0 with a local `opencode serve`.

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
  and the OpenCode credential rotate independently.
- `/login`, `/logout` and `/api/me` are explicit handles above the catch-all.
- `health_uri /api/info` with the same injected credential marks a dead upstream
  unhealthy and serves an offline page.
- SSE needs no special flush configuration in Caddy; long response times are
  covered by `stream_timeout`.

Difference for this app: the BFF, not the browser, talks to OpenCode. The BFF is
the only component that needs the OpenCode Basic credential and holds it
server-side (`OPENCODE_USERNAME` + `OPENCODE_PASSWORD`). The artifact origin
stays credential-free and is addressed only through signed URLs.

**Status:** verified on 2.3.0. The BFF sets the Basic header itself; an edge
credential is optional and independent.

Generate:

```bash
openssl rand -base64 32                 # SESSION_SECRET
openssl rand -base64 32                 # ARTIFACT_SIGNING_KEY
caddy hash-password --plaintext '...'   # optional edge basic_auth credential
```

## OpenCode administration

Provider keys, custom models, MCP servers and OAuth are configured in OpenCode,
not reimplemented in our UI. There are four supported ways to reach that
configuration, in order of preference:

1. **Local only:** run `opencode` on the host or over SSH. Nothing is exposed.
2. **Code surface (recommended for remote use):** `CODE_SURFACE=on` embeds the
   original OpenCode web UI from `CODE_HOST_URL`, behind the app's auth. See
   [`06-code-surface.md`](06-code-surface.md).
3. **Config-only admin proxy (fallback):** the BFF serves `/admin/opencode/*`
   behind the same session cookie and forwards only the configuration
   endpoints. The OpenCode port stays unpublished.
4. **No public subdomain.** An unauthenticated `opencode.example.com` host is
   not supported: it would publish a shell-capable backend.

The Code surface subsumes the admin proxy for normal use; `ADMIN_PROXY` remains
for deployments that cannot add a second hostname. With either off, the settings
page says "configure OpenCode on the host" and shows no link.

## Remote OpenCode host

The BFF can run next to the UI while OpenCode runs on another machine. The
browser still talks only to the BFF; the BFF is the only client of the remote
host and holds its Basic credential.

1. **Private network (preferred).** Give the Code host a WireGuard or Tailscale
   address and set `OPENCODE_URL=http://100.x.y.z:4096`. Bind OpenCode to that
   interface and allow only the BFF's address.
2. **SSH tunnel.** When there is no private network:

   ```bash
   ssh -N -L 4096:127.0.0.1:4096 owner@code.example.com
   ```

   and set `OPENCODE_URL=http://127.0.0.1:4096`. Supervise the tunnel (systemd
   unit, `autossh`, Tailscale). A dead tunnel fails `/api/info` and every API
   call with `500 internal_error`; `/healthz` is liveness-only and stays `200`,
   so probe `/api/info` for upstream health. It never falls back to a local
   default.
3. **Never publish port 4096.** No public DNS name, no port forwarding and no
   unauthenticated reverse proxy in front of it.

`OPENCODE_URL` is validated at boot: a malformed value, a non-http scheme or
embedded credentials (`http://user:pass@host`) stop the boot instead of
silently pointing at localhost. The Code host proxy stays next to the app, not
on the remote machine, so the browser never opens a connection to the remote
host and the remote credential never enters a page.

**Stream and latency.** The event route is an unbuffered SSE response
(`Content-Type: text/event-stream`, `Cache-Control: no-cache, no-transform`,
`X-Accel-Buffering: no`), starts with `retry: 2000` and sends a
`: heartbeat` comment every 15 seconds. The browser's `EventSource` reconnects
on its own; the UI counts reconnects and resynchronizes from scratch. Latency
is dominated by the tunnel round trip per request and per event, not by
throughput: a 20–50 ms tunnel is unnoticeable for chat, while 100 ms and more
adds to every delta. A reverse proxy in front of the BFF must keep response
buffering off for `text/event-stream`.

**Backups and upgrades** (run on the remote host):

- Back up `opencode-data`, `opencode-config`, `workspace` and the deployment
  `.env` or secret store. Snapshot before every upgrade and test a restore into
  a scratch directory.
- Upgrade: pin the image digest, back up, pull, restart, run the smoke check,
  keep the previous digest for rollback. OpenCode's version and the pinned
  `@opencode/client` should agree; a mismatch is a warning, not an automatic
  migration.

**Smoke check.** The BFF ships a CLI that behaves like a browser:

```bash
OPENCHAT_SMOKE_URL=https://chat.example.com \
OPENCHAT_PASSWORD=... \
OPENCODE_PASSWORD=... \
pnpm --filter @openchat/server run smoke:remote -- --heartbeat-ms 20000
```

It logs in (session cookie with `HttpOnly`, `SameSite` and — over https —
`Secure`; or `Authorization: Basic` when the deployment runs `AUTH_MODE=basic`;
`--user`/`OPENCHAT_USER` default to `owner`), checks
`/healthz`, `/api/info` and the event stream (retry frame, keepalive and
headers), prints the measured time for each step, and fails if `mode` is not
`live`. It scans the four response bodies it reads for `OPENCODE_PASSWORD` and
`OPENCODE_URL`; add more with `--forbid <string>`. It warns when the URL is
plain `http` to a non-loopback host. Exit codes: `0` pass, `1` a check failed,
`2` a usage error. Against a local deployment the same command takes
`--url http://127.0.0.1:8787`; `--allow-fake` skips the live-mode requirement.
Every non-stream request has a 10 s deadline; the stream's headers are bounded
by the same deadline and its body by `--stream-ms`/`--heartbeat-ms`, so a
half-open tunnel fails instead of hanging.

## Code surface

- `CODE_SURFACE=on` renders a **Chat | Code** switch. Code is an iframe of
  `CODE_HOST_URL`.
- The Code host (a small proxy service) holds the OpenCode Basic credential,
  validates a single-use ticket minted by the BFF, sets its own host-only
  cookie, and forwards `/api/*` and the event stream.
- The iframe origin is separate from the app and the artifact host. No cookie
  is shared; the artifact origin never gets a session.
- `CODE_TICKET_SECRET` signs `{ sub, codeHost, exp, jti }`; TTL ≤ 60 s.
- The Code host adds `frame-ancestors https://chat.example.com` and does not
  weaken OpenCode's CSP.
- The surface can run shell commands; it is an admin surface with the same auth
  strength as the app.
- Remote OpenCode: point `OPENCODE_URL` at the remote host; the Code proxy stays
  next to the app and the browser never talks to the remote machine directly.

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
    Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-src https://artifacts.example.com https://code.example.com; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
  }
  reverse_proxy app:8787
}

artifacts.example.com {
  header {
    Content-Security-Policy "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors https://chat.example.com"
    X-Content-Type-Options "nosniff"
    Referrer-Policy "no-referrer"
    Cache-Control "no-store"
  }
  reverse_proxy artifacts:3001
}

code.example.com {
  header {
    # `+` appends a second policy; a bare header would replace OpenCode's own
    # CSP and drop its default-src/script-src protection. Multiple CSP headers
    # are enforced as an intersection.
    +Content-Security-Policy "frame-ancestors https://chat.example.com"
    # Remove an upstream X-Frame-Options; frame-ancestors is the control here.
    -X-Frame-Options
    X-Content-Type-Options "nosniff"
    Referrer-Policy "no-referrer"
    Cache-Control "no-store"
  }
  reverse_proxy code:3002
}
```

The artifact origin has **no authentication**: it serves only signed, short-lived
URLs (`?exp=…&sig=…`, HMAC with `ARTIFACT_SIGNING_KEY`). Adding Basic Auth would
break the cross-origin iframe and contradict the "no credentials" rule. The
artifact container joins only the internal `artifacts` network, so it has no
default route and no path to `opencode` or `code`.

The Code host requires the app's ticket (see
[`06-code-surface.md`](06-code-surface.md)); without it the request redirects to
the app login. Caddy only terminates TLS and adds headers.

`img-src` deliberately omits `https:`. With any remote image source an artifact
can exfiltrate data through `new Image().src`. Remote images are proxied by the
artifact host if a use case requires them.

## Session cookie

- `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, **no `Domain` attribute**
  (host-only). Host-only is what keeps `chat.example.com` cookies off
  `artifacts.example.com`; never set a registrable-domain cookie.
- Signed with `SESSION_SECRET`; rotate the secret to invalidate all sessions.
- TTL from `SESSION_TTL_SECONDS`; the lifetime is fixed, with no sliding
  renewal (deferred to the M7 deployment work in
  [`../spec/07-settings-auth.md`](../spec/07-settings-auth.md)).
- Logout clears the cookie. There is no server-side session record yet, so a
  copied cookie stays valid until its expiry; revoking sessions means rotating
  `SESSION_SECRET`.

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
- Rotate `SESSION_SECRET` and the password after any suspected exposure.

## Feature flags

Some capabilities sit behind `experimental.*` configuration keys. The 2.3.0
config schema documents, among others: `todo`, `artifacts`, `schedules`,
`image_generate`, `mcp_events`, `background_compaction`, `media_blob`,
`part_rows`, `subagent_depth`, `location_idle_timeout`, `policies`,
`portable_shell_scanner`, `codemode_vm`, `console_watches` and `all_flags`.
The event is `experimental.mcp.event`; the config key is `mcp_events`.

Verified behavior: with `experimental.artifacts` unset, the artifact API returns
`403 ForbiddenError: Artifacts are disabled; set experimental.artifacts in
config`. With it enabled, provider `local` (`capabilities: ["static"]`) serves
`create/list/get/update/view/delete`.

Before a feature ships:

1. Check the pinned OpenCode config schema for the exact flag name.
2. Enable it in `opencode.json` on the OpenCode volume, never in the browser.
3. Record the flag in this document and in the feasibility matrix row.

No flag is enabled by default. A feature whose flag is absent hides its UI
instead of failing at runtime.

## Speech-to-text

Dictation is an optional local service, not an OpenCode feature.

- `STT_URL` points at a Whisper-compatible endpoint. The BFF posts to
  `${STT_URL}/audio/transcriptions` (so include `/v1` in the URL when the
  service expects it), typically `whisper.cpp` or `faster-whisper` on the same
  host or a GPU box.
- The browser records and posts the raw audio to `POST /api/transcribe` with an
  `audio/*` content type; the BFF forwards it as `multipart/form-data` with
  `model=whisper-1` and an optional `?language=` hint, and adds `STT_API_KEY`
  server-side.
- Audio is buffered in memory only, with a size and duration cap; the BFF does
  not write it to disk and does not log it.
- A local model uses no provider quota. If the owner points `STT_URL` at a
  hosted service, that is an explicit choice and must be documented.
- With `STT_URL` empty, the microphone button is not rendered.

### Dictation API

`POST /api/transcribe` is behind the same session/basic auth and the same
same-origin guard as every other state-changing route. It accepts only
`audio/*` and answers with one of:

| Status | Condition |
| --- | --- |
| `200` | `{ text, durationMs }`; `durationMs` is the upstream call time |
| `400` | the audio body is empty |
| `401` | no valid session or Basic credential |
| `403` | cross-origin `Origin` or `Sec-Fetch-Site` (the shared guard applies here too) |
| `413` | declared or streamed body exceeds `DICTATION_MAX_BYTES` |
| `415` | `Content-Type` is missing or not `audio/*` |
| `422` | the service returned no non-empty `text` |
| `502` | upstream status other than 2xx, network error, or invalid JSON |
| `503` | `STT_URL` is unset |
| `504` | the upstream call exceeded 30 s |

`/api/info` advertises `dictation: { enabled, maxSeconds, maxBytes }`; the UI
hides the control when `enabled` is false but a direct call still fails with
`503`.

Privacy properties: the audio arrives on the same origin as the app, is read
incrementally with the byte cap enforced while the upload is still in flight,
is forwarded from memory inside the same request, and is never persisted. The
BFF does not log the body, the transcript, the `STT_API_KEY` or the upstream
response; only `{ text, durationMs }` leaves the route. Avoiding a temporary
file means a crash or a full disk cannot leave a recording behind.

## Testing without quota

`BACKEND_MODE=fake` swaps the `ChatBackend` port for a deterministic in-process
fake: scripted event sequences, fixed text, no OpenCode and no provider. It is
how the E2E suite runs and how the owner can exercise the UI without spending
quota. See [`05-testing.md`](05-testing.md).

## Deployment sketch

```yaml
services:
  caddy:
    image: caddy:2
    ports: ["80:80", "443:443"]
    volumes: ["./Caddyfile:/etc/caddy/Caddyfile:ro", "caddy-data:/data"]
    networks: [frontend, artifacts]
    depends_on: [app, artifacts]

  app:
    build: ./apps/server
    environment:
      AUTH_MODE: session
      HOST: 0.0.0.0
      PORT: 8787
      TRUST_PROXY: "1"
      OPENCHAT_USER: ${OPENCHAT_USER}
      OPENCHAT_PASSWORD: ${OPENCHAT_PASSWORD:?set a non-default password}
      SESSION_SECRET: ${SESSION_SECRET:?set 32+ random bytes}
      SESSION_TTL_SECONDS: ${SESSION_TTL_SECONDS:-604800}
      COOKIE_SECURE: "1"
      ORIGIN: https://chat.example.com
      OPENCODE_URL: http://opencode:4096
      OPENCODE_USERNAME: opencode
      OPENCODE_PASSWORD: ${OPENCODE_PASSWORD:?set a random password}
      WORKSPACE_DIR: /workspace
      ARTIFACT_HOST_URL: https://artifacts.example.com
      ARTIFACT_SIGNING_KEY: ${ARTIFACT_SIGNING_KEY}
      ADMIN_PROXY: "off"
      STT_URL: ${STT_URL:-}
      STT_API_KEY: ${STT_API_KEY:-}
      DICTATION_MAX_SECONDS: ${DICTATION_MAX_SECONDS:-120}
      DICTATION_MAX_BYTES: ${DICTATION_MAX_BYTES:-26214400}
      BACKEND_MODE: ${BACKEND_MODE:-live}
      CODE_SURFACE: ${CODE_SURFACE:-off}
      CODE_HOST_URL: ${CODE_HOST_URL:-}
      CODE_TICKET_SECRET: ${CODE_TICKET_SECRET:-}
    networks: [frontend, backend, artifacts]
    depends_on: [opencode]

  code:
    build: ./apps/code-host
    environment:
      OPENCODE_URL: http://opencode:4096
      OPENCODE_USERNAME: opencode
      OPENCODE_PASSWORD: ${OPENCODE_PASSWORD:?same value as the BFF}
      CODE_TICKET_SECRET: ${CODE_TICKET_SECRET:?set a ticket secret}
      APP_ORIGIN: https://chat.example.com
    networks: [frontend, backend]
    depends_on: [opencode]

  artifacts:
    build: ./apps/artifact-host
    environment:
      ARTIFACT_SIGNING_KEY: ${ARTIFACT_SIGNING_KEY}
    read_only: true
    # No egress: `internal: true` removes the default route, so an artifact
    # that navigates its frame to an external host dies at the network. This is
    # the only control for self-navigation; CSP cannot stop it. Only Caddy and
    # the BFF join this network.
    networks: [artifacts]
    deploy:
      resources:
        limits:
          cpus: "0.50"
          memory: 256M

  opencode:
    image: ${OPENCODE_IMAGE:?pin a verified image tag}
    command: ["opencode", "serve", "--hostname", "0.0.0.0", "--port", "4096"]
    environment:
      OPENCODE_PASSWORD: ${OPENCODE_PASSWORD:?same value as the BFF}
    volumes:
      - opencode-data:/root/.local/share/opencode
      - opencode-config:/root/.config/opencode
      - workspace:/workspace
    networks: [backend]
    # no published ports: reachable only from the BFF and the Code host

networks:
  frontend:
  backend:
  artifacts:
    # No route to the internet and no route to backend/opencode.
    internal: true

volumes:
  caddy-data:
  opencode-data:
  opencode-config:
  workspace:
```

The image name is intentionally not hard-coded: verify the published OpenCode
image (or build it) and pin a digest before deploying. The BFF reaches OpenCode
only over the private `backend` network; `ADMIN_PROXY` (same-origin
`/admin/opencode`) stays `off` unless the owner enables it. The Code host is
enabled with `CODE_SURFACE=on` and is the only other component with a route to
OpenCode.

The artifact host shares the internal `artifacts` network with Caddy and the app
but has no route to the internet and no route to `opencode` or `code`; it holds
no provider keys and no session secret.

## Operations

- **Health:** `/healthz` checks the BFF and OpenCode `/api/info`.
- **Backups:** OpenCode data, config, workspace and `.env`. Test a restore.
- **Updates:** pin versions, back up, update, run the smoke suite, keep the
  previous image tag.
- **Logs:** structured JSON, no prompt content, retention bounded.
- **Monitoring:** uptime, disk, error rate, stream disconnects.
- **Kill switch:** stop the `opencode` service to disable all agent execution
  without taking the UI down.
- **Incident:** rotate `SESSION_SECRET`, rotate the password, inspect audit
  logs, check for unexpected shell/network activity.

## Out of scope

Multi-user accounts, roles, OAuth, public sharing. The architecture leaves room
for them, but the security model would need a redesign.
