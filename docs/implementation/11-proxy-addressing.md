# 11 — Proxy addressing and the throttle key

**Status:** 2026-11-18. Implements issue #31. This is the bucket key for every
per-client throttle in the BFF: login failures, prompt submissions, ticket
mints and app actions. Files: `apps/server/src/middleware.ts`,
`apps/server/src/throttle.ts`, `apps/server/test/proxy-address.test.ts`.
Deployment configuration itself lives in
[`../architecture/03-auth-deployment.md`](../architecture/03-auth-deployment.md)
and is owned there; this document states the requirement only.

## The rule

`clientAddress(c, trustProxy)` produces the throttle key:

1. `TRUST_PROXY` off: `c.env.remoteAddress`, or `"local"` when the adapter
   reports no socket address. Forwarding headers are not read at all.
2. `TRUST_PROXY` on: split `X-Forwarded-For` on `,`, trim every entry, drop
   empty ones, and take the **last** remaining entry. If there is none, use
   `X-Real-IP`, trimmed, when it is non-empty. If neither header yields a
   value, fall back to the socket address as in step 1.
3. Never return an empty string (`"local"` is the floor), and cap the result at
   128 characters so a huge header cannot grow the throttle map. No IP syntax
   or port parsing: the value is a bucket key, not an attribution that is
   displayed.

`TRUST_PROXY` is a boolean parsed from `TRUST_PROXY`; no new variable is
introduced.

## Why the last entry

The two proxies the deployment targets append the hop they observed:

- nginx: `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;` sends
  the incoming header plus `$remote_addr`.
- Traefik: appends the client address to the incoming list.

So with `client → proxy → BFF`, the header arriving at the BFF is
`<whatever the client sent>, <client address as seen by the proxy>`. The first
entry is written by the client; only the rightmost entry was added by the
trusted proxy. Keying on the first entry let a client rotate it and get a fresh
bucket per request. Measured before the fix with `TRUST_PROXY=1`:

```
25 mints, rotating X-Forwarded-For                 -> 200 x25
25 mints, "X-Forwarded-For: <attacker>, <real ip>" -> 200 x25
no TRUST_PROXY                                     -> 200 x20, then 429
```

After the fix all three rows behave as the last one: the first 20 mint
requests share one bucket and the 21st answers `429`; the login-failure
throttle shares the same key and behaves identically.

A proxy that **overwrites** the header with `$remote_addr` (rather than
appending) is also safe: the list then has one entry and it is the observed
address. A proxy that **passes the header through untouched** is not: the last
entry would then also be client-written. The requirement is therefore "append
(or overwrite with the observed address), never pass through".

## The single-proxy assumption

The rule assumes **exactly one** reverse proxy between the client and the BFF,
and that the BFF listener is not reachable around it. Both are part of the
documented topology in the owner's deployment guide; this document does not
edit it.

- **Two chained proxies.** Each appends a hop, so the last entry is the inner
  proxy's address, not the client's. Every client behind the inner proxy would
  share one bucket: the limit fails closed (a single global budget) rather than
  open, but the per-client guarantee is gone. Correct handling needs a
  configured hop count (`TRUSTED_PROXY_HOPS` or an equivalent trusted-CIDR
  list). That is deliberately out of scope for this slice; no such variable
  exists.
- **Directly reachable BFF with `TRUST_PROXY=1`.** The client can send its own
  `X-Forwarded-For`, and its last entry is then trusted. This is equivalent to
  the pre-fix spoof and defeats every throttle. Keep `HOST` on loopback (or a
  private interface) and expose only the proxy.
- **Proxy that strips `X-Forwarded-For` but sets no `X-Real-IP`.** The
  fallback then reads a header the client wrote. The fallback is only a
  convenience for proxies configured to set `X-Real-IP`; when
  `X-Forwarded-For` is present (the normal case), it always wins.

## Throttle map bound

`FixedWindowThrottle` holds one bucket per key in memory and
`MAX_TRACKED_ADDRESSES = 1024`. When a new key is recorded and the map already
has at least 1024 entries, `prune()` deletes only buckets whose window has
expired (`resetAt <= now`). Live buckets are never evicted, so the constant is
**not a hard cap** on the map: it bounds stale growth and keeps the pruning
pass from running on every request. With the correct key — the hop the
appending proxy added — a single client cannot rotate keys, so the map grows
with the number of distinct client addresses seen inside one window, not with
the number of requests. A wrong topology (directly reachable BFF,
`TRUST_PROXY=1`, pass-through proxy) lets one client add a bucket per request;
that is one more reason the topology requirement above is not optional.

No eviction of live buckets is added deliberately: evicting an active bucket
would reset a real client's budget and hand an attacker a throttle bypass.

## Tests

`apps/server/test/proxy-address.test.ts` runs without a network or real
OpenCode instance, with the fake backend and an injected
`FixedWindowThrottle`:

| Case | Expectation |
| --- | --- |
| No proxy, spoofed headers | Socket address wins. |
| Proxy, one entry | That entry. |
| Proxy, `"<attacker>, <real>"` | The last entry. |
| Proxy, `"a, b, , c"` | `c`; trailing-only empties fall back to the previous non-empty entry. |
| Proxy, only `X-Real-IP` | Trimmed `X-Real-IP`. |
| Proxy, no header | Socket address. |
| 500-character header | Key capped at 128 characters. |
| Empty socket address | `"local"`, never `""`. |
| 25 ticket mints, rotated first entry | One bucket: 20 × `200`, then `429` with `Retry-After`. |
| 11 failed logins, rotated first entry | Ten × `401`, then `429`. |
| Two different last entries | Separate buckets, no collapse. |
| 21 ticket mints without `TRUST_PROXY`, rotated headers | Unchanged: 20 × `200`, then `429`. |

## Manual check that remains

Tests prove the key derivation, not the deployment. The owner must confirm in
the deployed proxy configuration (see the deployment guide) that:

1. the BFF port is reachable only through the proxy;
2. the proxy appends to `X-Forwarded-For` (nginx
   `$proxy_add_x_forwarded_for`, Traefik's default append) or overwrites it
   with the observed address — it must not pass a client header through
   unchanged;
3. if the proxy does not send `X-Forwarded-For`, it sets `X-Real-IP` itself.

A quick check through the proxy with a forged first entry
(`curl -H 'X-Forwarded-For: 198.51.100.9' …`) shows the real client in the
resulting key: repeated requests must hit the same `429` boundary, not a fresh
budget each time.
