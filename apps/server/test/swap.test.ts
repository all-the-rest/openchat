import { spawnSync } from "node:child_process"
import type { SpawnSyncReturns } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

/**
 * Behaviour of deploy/swap.sh with a stubbed `docker` and `curl` on PATH.
 *
 * No container is built or started: the stubs record the compose invocations,
 * so the assertions are about ordering, links and rollback, which is exactly the
 * part of a deploy script that a typo breaks.
 */

const ROOT = resolve(import.meta.dirname, "..", "..", "..")
const SCRIPT = join(ROOT, "deploy/swap.sh")
const IS_WINDOWS = process.platform === "win32"

const DOCKER_STUB = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$DOCKER_LOG"
exit "\${STUB_DOCKER_EXIT:-0}"
`

const CURL_STUB = `#!/usr/bin/env bash
out=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) out=$2; shift 2 ;;
    --write-out|--max-time) shift 2 ;;
    *) shift ;;
  esac
done
count=0
if [ -n "\${CURL_COUNTER:-}" ]; then
  count=$(cat "$CURL_COUNTER" 2>/dev/null || echo 0)
  count=$((count + 1))
  echo "$count" > "$CURL_COUNTER"
fi
if [ -n "\${STUB_FAIL_CALLS:-}" ] && [ "$count" -le "$STUB_FAIL_CALLS" ]; then
  printf '{"ok":false}' > "$out"
  printf '503'
  exit 0
fi
printf '%s' "\${STUB_BODY:-{\\"ok\\":true,\\"version\\":\\"9.9.9\\",\\"reachable\\":true}}" > "$out"
printf '%s' "\${STUB_STATUS:-200}"
`

interface Fixture {
  root: string
  stack: string
  log: string
  run: (args: string[], env?: Record<string, string>) => SpawnSyncReturns<string>
  release: (name: string) => string
}

const created: string[] = []

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "openchat-swap-"))
  created.push(root)
  const stack = join(root, "stack")
  const bin = join(root, "bin")
  const log = join(root, "docker.log")

  for (const release of ["r1", "r2"]) {
    mkdirSync(join(stack, "releases", release), { recursive: true })
    writeFileSync(join(stack, "releases", release, "compose.yaml"), "services: {}\n")
  }
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(stack, ".env"), "OPENCHAT_PASSWORD=placeholder\n")
  writeFileSync(join(bin, "docker"), DOCKER_STUB, { mode: 0o755 })
  writeFileSync(join(bin, "curl"), CURL_STUB, { mode: 0o755 })
  writeFileSync(log, "")

  const release = (name: string) => join(stack, "releases", name)

  return {
    root,
    stack,
    log,
    release,
    run: (args, extra = {}) =>
      spawnSync("bash", [SCRIPT, "--stack-dir", stack, ...args], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          DOCKER_LOG: log,
          CURL_COUNTER: join(root, "curl.count"),
          ...extra,
        },
      }),
  }
}

function dockerCalls(log: string): string[] {
  return readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
}

afterEach(() => {
  while (created.length > 0) {
    const dir = created.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe.skipIf(IS_WINDOWS)("deploy/swap.sh", () => {
  it("prints the plan and mutates nothing in a dry run", () => {
    const test = fixture()
    const result = test.run(["--release", test.release("r1"), "--dry-run"])

    expect(result.status).toBe(0)
    expect(result.stdout).toContain("would: docker compose")
    expect(result.stdout).toContain("would: ln -sfn releases/r1 current")
    expect(result.stdout).toContain("dry run: nothing was built, started, probed or linked")
    expect(existsSync(join(test.stack, "current"))).toBe(false)
    expect(existsSync(join(test.stack, "previous"))).toBe(false)
    expect(dockerCalls(test.log)).toEqual([])
  })

  it("swaps current to a validated release", () => {
    const test = fixture()
    const result = test.run(["--release", test.release("r1")])

    expect(result.status).toBe(0)
    expect(readlinkSync(join(test.stack, "current"))).toBe("releases/r1")
    expect(existsSync(join(test.stack, "previous"))).toBe(false)

    const calls = dockerCalls(test.log)
    expect(calls[0]).toContain("config -q")
    expect(calls[0]).toContain("releases/r1/compose.yaml")
    expect(calls[1]).toContain("up -d --wait")
    expect(result.stdout).toContain("swapped: current -> releases/r1")
  })

  it("records the previous release on a second swap", () => {
    const test = fixture()
    expect(test.run(["--release", test.release("r1")]).status).toBe(0)

    const second = test.run(["--release", test.release("r2")])
    expect(second.status).toBe(0)
    expect(readlinkSync(join(test.stack, "current"))).toBe("releases/r2")
    expect(readlinkSync(join(test.stack, "previous"))).toBe("releases/r1")
  })

  it("does nothing on a rerun against the current release", () => {
    const test = fixture()
    expect(test.run(["--release", test.release("r1")]).status).toBe(0)
    writeFileSync(test.log, "")

    const rerun = test.run(["--release", test.release("r1")])
    expect(rerun.status).toBe(0)
    expect(rerun.stdout).toContain("nothing to do")
    expect(dockerCalls(test.log)).toEqual([])
  })

  it("rolls back when the candidate never becomes healthy", () => {
    const test = fixture()
    expect(test.run(["--release", test.release("r1")]).status).toBe(0)
    writeFileSync(test.log, "")

    // A fresh counter: the first swap above already spent the shared one.
    const failed = test.run(["--release", test.release("r2"), "--timeout", "1"], {
      STUB_FAIL_CALLS: "2",
      CURL_COUNTER: join(test.root, "curl-rollback.count"),
    })

    expect(failed.status).toBe(1)
    expect(failed.stderr).toContain("rolling back to releases/r1")
    expect(readlinkSync(join(test.stack, "current"))).toBe("releases/r1")

    const calls = dockerCalls(test.log)
    expect(calls.at(-1)).toContain("releases/r1/compose.yaml")
    expect(calls.at(-1)).toContain("up -d --wait")
  })

  it("rolls back when compose refuses to start the candidate", () => {
    const test = fixture()
    expect(test.run(["--release", test.release("r1")]).status).toBe(0)

    const failed = test.run(["--release", test.release("r2")], { STUB_DOCKER_EXIT: "1" })
    expect(failed.status).toBe(1)
    expect(readlinkSync(join(test.stack, "current"))).toBe("releases/r1")
  })

  it("fails the version check without a swap when the running release reports another version", () => {
    const test = fixture()
    expect(test.run(["--release", test.release("r1")]).status).toBe(0)

    const mismatch = test.run([
      "--release",
      test.release("r1"),
      "--expect-version",
      "1.2.3",
    ])
    expect(mismatch.status).toBe(1)
    expect(readlinkSync(join(test.stack, "current"))).toBe("releases/r1")
  })

  it("accepts a degraded host as a valid deployment", () => {
    const test = fixture()
    const result = test.run(["--release", test.release("r1")], {
      STUB_BODY: '{"ok":true,"version":"9.9.9","reachable":false}',
    })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain("host unreachable (degraded, allowed)")
  })

  it("rejects usage errors with exit code 2", () => {
    const test = fixture()
    expect(test.run(["--bogus"]).status).toBe(2)
    expect(test.run([]).status).toBe(2)
  })

  it("refuses a stack without an env file and a release outside the stack", () => {
    const test = fixture()
    rmSync(join(test.stack, ".env"))
    const noEnv = test.run(["--release", test.release("r1")])
    expect(noEnv.status).toBe(1)
    expect(noEnv.stderr).toContain("missing .env")

    writeFileSync(join(test.stack, ".env"), "OPENCHAT_PASSWORD=placeholder\n")
    const outside = test.run(["--release", join(test.root, "bin")])
    expect(outside.status).toBe(1)
    expect(outside.stderr).toContain("inside")
  })

  it("never puts a secret on the command line", () => {
    const test = fixture()
    expect(test.run(["--release", test.release("r1")]).status).toBe(0)

    const calls = dockerCalls(test.log)
    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) {
      expect(call).toContain("--env-file")
      expect(call).not.toContain("placeholder")
      expect(call).not.toMatch(/OPENCHAT_PASSWORD=/)
    }
  })
})
