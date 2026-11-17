# Feature Parity with `opencode-web-gate`

OpenChat is the successor of
[`opencode-web-gate`](../../../opencode-web-gate) — not of its UI, which is
OpenCode's own web UI, but of everything around it: the login gate, the two
runtime paths, the deployment and the operating rules. This note inventories
what exists today, maps it to OpenChat, and lists the gaps that are not yet
specified.

Source facts were read from `opencode-web-gate` at `227afec` (2026-11-11):
`README.md`, `AGENTS.md`, both `Caddyfile.fragment` files, both
`docker-compose.yml`, `remote/Dockerfile`, `remote/entrypoint.sh`,
`local/bootstrap.sh`, `local/run.sh`, `local/apps/web/dist/login.html`.

## What it does today

| Capability | Today | OpenChat |
| --- | --- | --- |
| Chat UI | OpenCode's own web UI, unmodified | own chat surface (v1) + OpenCode UI as Code surface (V2, spec 13) |
| Login | static `login.html` → `POST /api/login` → HMAC cookie `auth=user:exp:sig`, HttpOnly/Secure/SameSite=Lax, TTL `SESSION_TTL` | own login route, i18n, `AUTH_MODE=session` (spec 07) |
| Edge gate | Caddy `forward_auth code-auth:8081` (`/check`), 401 → `302 /login.html` (never the browser password popup) | BFF session check; Caddy only terminates TLS (arch 03) |
| Credential handling | Basic credential injected by Caddy (`header_up Authorization`), never in the browser | BFF holds the OpenCode credential; browser never sees it |
| Two runtimes | local: Mac + `autossh` LaunchAgent + SSH reverse tunnel; remote: VPS container | `OPENCODE_URL` must support both (issue #16) |
| Shared server | one `opencode service` for TUI and web — one DB, one live stream, process-bound `running` state | BFF must attach to the same service, not spawn its own (new requirement) |
| Offline UX | 502/503/504 → `tunnel-down.html`; login page warns "Mac-Tunnel offline" | spec 13 states "Code host down" / "Offline"; chat needs the same banner |
| Deploy | `rsync`/`ssh` of `compose.yaml` to `/opt/stacks/<stack>` via `.compose.candidate.*` → validate → atomic replace → `up -d --wait`, rollback from `.compose.previous.*`, `--dry-run` | M7 (#9) covers compose/TLS/backups; the atomic deploy pattern is worth keeping |
| Secrets | host `.env` only (`root:root 0600`), never synced; `AUTH_HASH` + `OPENCODE_PASSWORD` are different secrets | same rule, `OPENCODE_PASSWORD` canonical (arch 03) |
| Agent sandbox | `code-dev` + rootless `dind` sidecar (2g/4g) for Docker-based tools | not specified — OpenCode tools may need Docker |
| Resource guards | `dind-guard.sh` (OOM), `dind-image-gc.sh`, `ram-watchdog.sh` | not specified |
| Toolchain | Debian bookworm, Node 26, pnpm, PHP 8.5, composer, gh, Docker CLI, ripgrep, sqlite3 | out of scope for the app image, relevant for the Code host image |
| Git identity | `GIT_AUTHOR_*`/`GIT_COMMITTER_*` env + `entrypoint.sh` rewrites `~/.gitconfig` and `gh auth setup-git` on every start | ops note for the remote host |
| Authz on `/sw.js` | OpenCode service worker neutralized (stale precache) | we embed the UI, so the same neutralization applies to the Code host |
| PWA CORS | blanket `OPTIONS` + exact-header match `@api_ok` for `/api/*` | unnecessary: our app is same-origin and uses `@opencode/client` through the BFF |
| Updates | `OPENCODE_AUTOUPDATE*` in the remote stack; weekly CI image rebuild | pinned-version policy (spec 13 "version mismatch") |

## Gaps to close

1. **Local tunnel mode.** OpenChat specifies a remote host (FR-43) but not the
   Mac-behind-a-tunnel mode. Needs one `OPENCODE_URL`, a documented tunnel
   setup, and the offline/`tunnel-down` state in chat, not only in Code.
2. **Shared OpenCode service.** Starting a second `serve` reads the same SQLite
   but has its own process-bound `running` state; the web then misses a running
   TUI turn. The BFF must be configured to attach to the existing service.
3. **Agent tool runtime.** If OpenCode's shell tool needs Docker, the Code host
   needs the rootless dind sidecar and its memory limits. Without it, agent
   workflows that build or test containers silently fail.
4. **Resource guards.** RAM watchdog, dind OOM guard and image GC are
   operational requirements on a small VPS; they belong in the deployment
   runbook, not in a README of the predecessor.
5. **Update policy.** Either pin OpenCode and upgrade deliberately (matches
   spec 13's version-mismatch warning) or auto-update. The predecessor
   auto-updates; OpenChat currently does not decide.
6. **Deploy safety.** The candidate/previous compose swap with validation and
   rollback, plus `--dry-run`, should survive the rewrite.
7. **Migration.** The predecessor's domains, cookies and stacks must be
   replaceable without two parallel auth systems. A short cutover note belongs
   in the deployment doc.

## Non-goals

- Rebuilding OpenCode's UI (V2 embeds it, ADR-0005).
- Keeping the PWA CORS edge gate: OpenChat is same-origin and its Code origin
  uses the ticket flow.
- Keeping the Python auth sidecar: the BFF owns sessions; Caddy only proxies.
- Keeping two login pages (local/remote): one app login, one i18n.

Tracking: #20.
