# 19 — Login: username, password and the bcrypt takeover path

**Status:** 2026-11-18. Files: `packages/contracts/src/index.ts`
(`loginRequestSchema`), `apps/server/src/auth.ts` (`verifyCredentials`),
`apps/server/src/env-auth.ts`, `apps/server/src/routes.ts`,
`apps/web/src/pages/LoginPage.tsx`, `apps/web/src/auth/provider.tsx`.
Deployment values live in [`14-deployment.md`](14-deployment.md) and stay
owned there; this note covers the rule and the rotation story.

## Why a username too

The predecessor stack on the same host already asks for a user and a password,
and its edge gate carries both. A login that accepts only a password would
silently drop half of the credential pair during a takeover: two people sharing
one password, or a typo in the username, would still authenticate. OpenChat is
single-user, so the username is not a user directory — it is the identity the
session is minted for and the first half of the check.

| Field | Bounds | Client |
| --- | --- | --- |
| `user` | 1–64 characters | visible label, `autocomplete="username"` |
| `password` | 1–256 characters | unchanged password field |

Both are required by `loginRequestSchema`; a body without either answers 400
before the throttle or the password work runs.

## Verification

`verifyCredentials(user, password, settings)` checks the username
constant-time against `OPENCHAT_USER` and the password against exactly one
source. The username result is **not** used to skip the password work: both
checks always run and are combined at the end, so an unknown username costs the
same bcrypt round as a known one with a wrong password. The route still records
one failure per address in the existing fixed-window throttle (10 failures per
minute), and a success clears the bucket. The 401 body is the same for a wrong
username and a wrong password: neither half is confirmed.

Two password sources exist:

| `OPENCHAT_PASSWORD` | `OPENCHAT_PASSWORD_HASH` | Result |
| --- | --- | --- |
| set | empty | constant-time plaintext compare (the original path) |
| empty | set | bcrypt compare (`$2a$`, `$2b$`, `$2y$`) |
| set | set | startup error: one source must win, and neither may silently |
| empty | empty | startup error: no credential at all |

The hash is validated at boot (prefix, cost 04–31, 60 characters), so a typo is
a boot failure rather than a login that can never succeed. Verification uses
`bcryptjs` (MIT, pure JavaScript, no postinstall or native toolchain), which
also reads hashes produced by other stacks — including the predecessor's
`$2a$14$…` value — without the plaintext. `AUTH_MODE=basic` is unchanged and
still needs the plaintext pair; a hash with basic auth is refused at boot.

## Docker Compose and the `$` in credentials

Compose interpolates `$` in `.env` values, so a hash written as
`$2b$12$abc…` arrives as `$2b$12` — the rest is read as an unset variable. The
symptom is not a boot error but every login failing. In a Compose `.env`, double
every `$` in `OPENCHAT_PASSWORD_HASH` (`$$2b$$12$$abc…`), and do the same for any
`OPENCHAT_PASSWORD` that contains `$`. The deploy script escapes the value
automatically; outside Compose (systemd, a shell `export`) no escaping is
applied and the value must keep its single `$`. Boot validation (`$2a$`/`$2b$`/
`$2y$`, exactly 60 characters) means an over-escaped value fails loudly instead
of silently accepting no login.

## Rotation

- **New password or hash:** replace the environment value and restart. Sessions
  are signed with `SESSION_SECRET` and carry only the username and expiry, so
  existing sessions stay valid.
- **Rename `OPENCHAT_USER`:** every existing session becomes invalid because
  cookie validation also compares the username.
- **Invalidate every session now:** rotate `SESSION_SECRET`. All cookies fail
  signature verification at once; no per-session store exists to purge.

## The edge stays a gate, not the login

Caddy terminates TLS and routes the app and the optional Code and artifact
hosts. It does not authenticate: the login form, the throttle, the signed
cookie and the bcrypt compare are the application's, so the same rules hold
behind a tunnel or a direct loopback port. A basic-auth gate in front of the
app is allowed as a second layer but is never the only check.
