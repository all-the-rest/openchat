/**
 * CLI surface of the smoke tool: argument parsing and the exit-code contract.
 * The checks themselves live in `smoke.ts`; this module never touches the
 * network on import.
 */

import { DEFAULT_STREAM_MS, DEFAULT_USER, messageOf, runSmoke } from "./smoke"

function positiveInt(raw: string, name: string, minimum: number): number {
  if (raw.trim().length === 0) throw new Error(`${name} requires a value`)
  const value = Number(raw)
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}`)
  }
  return value
}

function isLoopback(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, "")
    return host === "localhost" || host === "127.0.0.1" || host === "::1"
  } catch {
    return false
  }
}

/** Normalises like the boot does: concrete origin, no trailing slash/query/hash. */
function normalizeUrl(raw: string): string {
  try {
    const url = new URL(raw)
    const path = url.pathname.replace(/\/+$/, "")
    return path.length > 0 ? `${url.origin}${path}` : url.origin
  } catch {
    return raw.replace(/\/+$/, "")
  }
}

export interface SmokeArgs {
  url: string
  password: string
  user: string
  streamMs: number
  heartbeatMs: number
  requireLive: boolean
  forbidden: string[]
}

/**
 * Argument parser for the CLI. Kept here so the smoke tool has one tested
 * surface and no hidden `process.argv` reads.
 */
export function parseSmokeArgs(
  argv: string[],
  env: Record<string, string | undefined> = {},
): SmokeArgs {
  const args: SmokeArgs = {
    url: env.OPENCHAT_SMOKE_URL ?? "",
    password: env.OPENCHAT_PASSWORD ?? "",
    user: env.OPENCHAT_USER ?? DEFAULT_USER,
    streamMs: env.SMOKE_STREAM_MS
      ? positiveInt(env.SMOKE_STREAM_MS, "SMOKE_STREAM_MS", 1)
      : DEFAULT_STREAM_MS,
    heartbeatMs: env.SMOKE_HEARTBEAT_MS
      ? positiveInt(env.SMOKE_HEARTBEAT_MS, "SMOKE_HEARTBEAT_MS", 0)
      : 0,
    requireLive: true,
    forbidden: [],
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const value = () => argv[index + 1] ?? ""
    switch (argument) {
      // npm and pnpm both leave a bare `--` in argv depending on the call.
      case "--":
        break
      case "--url":
        args.url = value()
        index += 1
        break
      case "--password":
        args.password = value()
        index += 1
        break
      case "--user":
        args.user = value()
        index += 1
        break
      case "--stream-ms":
        args.streamMs = positiveInt(value(), "--stream-ms", 1)
        index += 1
        break
      case "--heartbeat-ms":
        args.heartbeatMs = positiveInt(value(), "--heartbeat-ms", 0)
        index += 1
        break
      case "--allow-fake":
        args.requireLive = false
        break
      case "--forbid":
        args.forbidden.push(value())
        index += 1
        break
      default:
        throw new Error(`Unknown argument: ${argument}`)
    }
  }
  return args
}

export interface CliDeps {
  fetchImpl?: typeof fetch
  log?: (line: string) => void
}

/**
 * Operator entry point. Returns the process exit code instead of exiting, so a
 * test can assert it: 0 pass, 1 a check failed, 2 usage error.
 */
export async function runCli(
  argv: string[],
  env: Record<string, string | undefined>,
  deps: CliDeps = {},
): Promise<number> {
  const log = deps.log ?? ((line: string) => console.log(line))
  let args: SmokeArgs
  try {
    args = parseSmokeArgs(argv, env)
  } catch (failure) {
    log(`error: ${messageOf(failure)}`)
    return 2
  }
  if (!args.url) {
    log("error: missing --url (or OPENCHAT_SMOKE_URL)")
    return 2
  }
  if (!args.password) {
    log("error: missing --password (or OPENCHAT_PASSWORD)")
    return 2
  }
  if (args.url.startsWith("http://") && !isLoopback(args.url)) {
    log("warning: plain http to a non-loopback host sends the password in clear text")
  }

  const forbidden = [...args.forbidden]
  if (env.OPENCODE_PASSWORD) forbidden.push(env.OPENCODE_PASSWORD)
  if (env.OPENCODE_URL) forbidden.push(normalizeUrl(env.OPENCODE_URL))

  const result = await runSmoke({
    baseUrl: args.url,
    password: args.password,
    user: args.user,
    streamMs: args.streamMs,
    heartbeatMs: args.heartbeatMs,
    requireLive: args.requireLive,
    forbidden,
    fetchImpl: deps.fetchImpl,
  })

  for (const entry of result.checks) {
    log(`${entry.ok ? "ok  " : "FAIL"} ${entry.name}: ${entry.detail}`)
  }
  log(result.failed === 0 ? "smoke: PASS" : `smoke: FAIL (${result.failed})`)
  return result.failed === 0 ? 0 : 1
}
