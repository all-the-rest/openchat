# 06 — Code Surface Architecture

Status: V2 (proposed 2026-11-17). V1 is chat-only.

The Code surface embeds the original OpenCode web UI. This document covers how
it is served, authenticated and isolated. If embedding proves impractical, V2
implements an equivalent surface itself; the switch and the one-front-door
requirement stay.

## What OpenCode serves

Verified on 2.3.0:

- `GET /` returns a Vite-style SPA shell that references **absolute** paths
  (`/icons/...`, `/site.webmanifest`, `/assets/...`).
- Its own CSP is `default-src 'self'; connect-src * data: blob:; frame-src
  'self' blob:; ...` and it sets no `frame-ancestors`, so an embedding app must
  add that header.
- The API is under `/api/*`; the UI calls it on the same origin. The server
  listens on one port and has no base-path flag.
- It requires Basic auth (`opencode:<password>`).

Consequence: serving the UI under the app's path prefix (`/code/`) would
require rewriting absolute asset and API paths on every upgrade. Do not do it.

## Options

| Option | Pros | Cons | Verdict |
| --- | --- | --- | --- |
| **A. Dedicated origin `code.example.com`** pointing at the OpenCode listener through an auth proxy | No path rewriting; upstream stays intact; clean origin isolation; websockets work | Second hostname; needs cross-host session/ticket | **Recommended** |
| B. Reverse proxy under `/code/` on the app origin | One hostname; cookie already there | Absolute paths and `/api` collide with the BFF; fragile rewrites | Rejected |
| C. New tab only | Simplest | Not the "one front door" the owner asked for | Fallback |

## Recommended shape

```
browser ──TLS──▶ chat.example.com (BFF, session cookie)
   │                  │
   │                  └── mints ticket ──▶ code.example.com/ticket?…
   │                                            │ validates ticket
   │                                            ▼
   └── iframe ──▶ code.example.com ──▶ auth proxy ──▶ opencode:4096
```

### Ticket flow

1. The authenticated BFF mints a single-use ticket:
   `HMAC(codeTicketSecret, { sub, codeHost, exp, jti })`, TTL ≤ 60 s.
2. The iframe URL is `https://code.example.com/__auth?ticket=…&next=/`.
3. The Code host validates the ticket, sets its own **host-only** session
   cookie (`HttpOnly`, `Secure`, `SameSite=Lax`, no `Domain`) and redirects to
   `next`. The ticket cannot be replayed.
4. The Code host proxies to OpenCode and injects the Basic credential.
5. On expiry, the host redirects to the app, which re-mints a ticket.

Why a ticket and not a shared cookie: a cookie for `chat.example.com` is not
sent to `code.example.com`; a registrable-domain cookie would also leak to the
artifact origin. A one-time exchange keeps each host's cookie separate.

### Headers at the Code host

```
Content-Security-Policy: frame-ancestors https://chat.example.com
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Cache-Control: no-store
```

Do not weaken OpenCode's own CSP; add only `frame-ancestors` at the proxy.

### Websockets

OpenCode's UI uses the event stream and possibly websockets. The proxy must pass
`Upgrade`/`Connection` and long-lived responses without buffering. Test a live
stream through the proxy, not just a page load.

## OpenCode credential

- The proxy holds `OPENCODE_USERNAME` + `OPENCODE_PASSWORD` server-side and
  injects `Authorization: Basic …` upstream.
- The browser never sees it.
- Rotating the password restarts the proxy and the BFF together; both read the
  same secret.

## Remote host

- `OPENCODE_URL` may point at a remote machine over a private network, a
  WireGuard/Tailscale address or an SSH tunnel.
- The Code host proxy runs next to the app, not on the remote machine, so the
  browser never talks to the remote OpenCode directly.
- The remote host owns chats, workspace and provider keys; backups run there.
- Latency is dominated by the tunnel; the BFF keeps SSE unbuffered and sends
  keepalives.

## Security boundaries

- The Code surface is as powerful as the chat: it can run shell commands and
  read the workspace. Treat it as an admin surface with the same auth.
- No anonymous access, no share links, no public subdomain.
- The artifact origin is a different host with no route to the Code host.
- Rate-limit ticket minting and the Code host's login exchange.
- Log ticket failures, never ticket values.

## Failure modes

| Failure | Behavior |
| --- | --- |
| Ticket expired | 401 from Code host → app re-mints once, then shows sign-in |
| OpenCode down | proxy returns 502 with a JSON error; the slim bar shows "Code host down" |
| Version mismatch | compare `server.info().version` with the pinned client; warn, do not block |
| Third-party cookies blocked | the ticket flow uses a top-level redirect inside the iframe, so it still works; if a browser blocks it, fall back to a new tab |
| CSP blocks the frame | show the reason and the new-tab fallback |

## Testing

- E2E with a stub Code host that serves a minimal page and checks ticket
  single-use, cookie flags, `frame-ancestors` and the new-tab fallback.
- A proxy test asserts `Authorization` is injected and never echoed.
- A websocket/SSE test asserts no buffering.
- No test opens the real reference product.
