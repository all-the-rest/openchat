import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { DEPLOY, ROOT, cleanupTemp, run, stub, temp } from "./remote-deploy-fixtures"

/**
 * Finding 1: every value interpolated into a remote command line must be
 * quoted or rejected. A fake `ssh` records the command the driver would send;
 * each recorded command is then replayed under a real POSIX `sh -c`, and the
 * marker file a hostile value tries to create must never appear.
 */

const SSH_STUB = `
for last do :; done
printf '%s\\n' "$last" >> "$SSH_LOG"
exit 0
`

/** Records the argv of every `bash <script> …` the remote shell would start. */
const BASH_STUB = `
{
  for arg in "$@"; do printf '%s\\037' "$arg"; done
  printf '\\n'
} >> "$BASH_LOG"
exit 0
`

interface Fixture {
  root: string
  bin: string
  sshLog: string
  bashLog: string
  env: Record<string, string>
}

function fixture(): Fixture {
  const root = temp("openchat-ssh-")
  const bin = join(root, "bin")
  mkdirSync(bin)
  stub(bin, "ssh", SSH_STUB, "#!/bin/sh")
  stub(bin, "rsync", "exit 0")
  // Both stubs run under /bin/sh: a `#!/usr/bin/env bash` shebang would resolve
  // `bash` through this stub PATH and exec the recorder instead of the stub
  // body (or recurse forever).
  stub(bin, "bash", BASH_STUB, "#!/bin/sh")
  stub(bin, "docker", "exit 0")
  stub(bin, "systemctl", "exit 0")
  stub(bin, "caddy", "exit 0")
  const sshLog = join(root, "ssh.log")
  const bashLog = join(root, "bash.log")
  writeFileSync(sshLog, "")
  writeFileSync(bashLog, "")
  return {
    root,
    bin,
    sshLog,
    bashLog,
    env: {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      SSH_LOG: sshLog,
      BASH_LOG: bashLog,
    },
  }
}

function replay(fixture: Fixture, commands: string[]): void {
  for (const command of commands) {
    // A non-zero status is expected (synthetic paths). The assertion is on the
    // marker, not the exit status.
    spawnSync("sh", ["-c", command], {
      encoding: "utf8",
      cwd: fixture.root,
      env: { ...process.env, ...fixture.env },
    })
  }
}

afterEach(cleanupTemp)

describe("remote commands are shell-quoted", { timeout: 90_000 }, () => {
  it("never executes an injected command for a hostile stack dir or predecessor path", () => {
    const test = fixture()
    const marker = join(test.root, "openchat-pwned")
    const hostileStack = join(test.root, `s; touch ${marker}; #`)
    const predecessor = join(test.root, "pre dir", ".env")

    const result = run(
      DEPLOY,
      [
        "--tag", "deadbeef",
        "--stack-dir", hostileStack,
        "--predecessor-env", predecessor,
      ],
      test.env,
    )
    expect(result.status, result.stderr).toBe(0)

    const commands = readFileSync(test.sshLog, "utf8").split("\n").filter(Boolean)
    expect(commands.length).toBeGreaterThan(5)
    const hostile = commands.filter((command) => command.includes(hostileStack))
    expect(hostile.length, "the hostile value must reach a remote command").toBeGreaterThan(0)
    replay(test, hostile)
    expect(existsSync(marker), "the injected `touch` must not run").toBe(false)

    // The predecessor path contains a space and must arrive as one argv word.
    const calls = readFileSync(test.bashLog, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("\u001f").filter((part) => part.length > 0))
    const bootstrap = calls.find((argv) => argv.some((arg) => arg.endsWith("env-bootstrap.sh")))
    expect(bootstrap).toBeDefined()
    expect(bootstrap).toContain(predecessor)
    expect(bootstrap?.filter((arg) => arg === predecessor)).toHaveLength(1)
  })

  it("rejects hostile --host, --expect-version, --tag and --domain before any ssh", () => {
    const test = fixture()
    const marker = join(test.root, "openchat-pwned")
    const cases: Array<[string, string]> = [
      ["--host", `-oProxyCommand=touch ${marker}`],
      ["--expect-version", `2.0$(touch ${marker})`],
      ["--tag", "2.0$(touch x)"],
      ["--domain", "chat;touch"],
    ]

    for (const [flag, value] of cases) {
      const result = run(DEPLOY, ["--tag", "deadbeef", flag, value], test.env)
      expect(result.status, `${flag} ${value}`).toBe(2)
    }
    expect(existsSync(marker)).toBe(false)
    expect(readFileSync(test.sshLog, "utf8")).toBe("")
  })

  it("rejects relative and parent-climbing paths and bad sizes with exit 2", () => {
    const test = fixture()
    const stack = temp("openchat-stack-")
    const cases: Array<[string, string]> = [
      ["--stack-dir", "relative/path"],
      ["--stack-dir", "/tmp/../etc"],
      ["--predecessor-env", "pre.env"],
      ["--artifacts-size", "2X"],
    ]
    for (const [flag, value] of cases) {
      const result = run(DEPLOY, ["--tag", "deadbeef", "--stack-dir", stack, flag, value], test.env)
      expect(result.status, `${flag} ${value}`).toBe(2)
      expect(result.stderr).toMatch(/absolute path|must not contain|K\/M\/G\/T/)
    }
  })

  it("keeps the driver and its quoting library in the synced file set", () => {
    const deploy = readFileSync(DEPLOY, "utf8")
    expect(deploy).toContain("ssh-safe.sh")
    expect(readFileSync(join(ROOT, "deploy", "remote", "ssh-safe.sh"), "utf8")).toContain("shquote()")
  })

  it("removes the boot unit and the installed helpers on --uninstall, and says what it keeps", () => {
    const test = fixture()
    const stack = join(test.root, "stack dir")
    const result = run(DEPLOY, ["--uninstall", "--stack-dir", stack], test.env)
    expect(result.status, result.stderr).toBe(0)

    const commands = readFileSync(test.sshLog, "utf8").split("\n").filter(Boolean)
    const joined = commands.join("\n")
    // The stack goes down before the unit does; `disable --now` runs ExecStop.
    expect(commands.findIndex((line) => line.includes("compose") && line.includes(" down"))).toBeLessThan(
      commands.findIndex((line) => line.includes("systemctl disable --now openchat-disks.service")),
    )
    expect(joined).toContain("rm -f /etc/systemd/system/openchat-disks.service")
    expect(joined).toContain("systemctl daemon-reload")
    // A space in the stack dir must not split into two words.
    expect(joined).toContain(`rm -rf '${stack}/bin'`)
    expect(joined).toContain(`cd '${stack}' &&`)
    expect(result.stdout).toContain("kept on purpose")
    expect(result.stdout).toContain(".env")
  })
})
