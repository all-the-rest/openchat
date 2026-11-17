/**
 * CLI for the remote-host smoke check. Prefer the environment so the password
 * does not appear in shell history or `ps`:
 *
 *   OPENCHAT_SMOKE_URL=https://chat.example.com \
 *   OPENCHAT_PASSWORD=... \
 *   OPENCODE_PASSWORD=... \
 *   pnpm --filter @openchat/server run smoke:remote -- --heartbeat-ms 20000
 *
 * Flags exist for a one-off local run (`--url`, `--stream-ms`, `--forbid`, …);
 * `--password` works but is visible to other local users. `OPENCODE_PASSWORD`
 * and `OPENCODE_URL` are never sent anywhere here; they are only added to the
 * forbidden list so a leaked response body fails the run.
 */

import { runCli } from "./smoke-args"

process.exitCode = await runCli(process.argv.slice(2), process.env)
