import { spawnSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

/**
 * Host guards (issue #36). Every case drives the real POSIX scripts with PATH
 * stubs for docker, systemctl, df and install; nothing starts a container,
 * touches /proc or needs root.
 */

const ROOT = resolve(import.meta.dirname, "..", "..", "..")
const HOST = join(ROOT, "deploy", "host")
const RAM = join(HOST, "ram-watchdog.sh")
const DIND = join(HOST, "dind-gc.sh")
const ARTIFACTS = join(HOST, "artifact-usage.sh")
const INSTALL = join(HOST, "install.sh")

const DOCKER_STUB = `
printf 'CALL\\n' >> "$GUARD_LOG"
printf 'ARG[%s]\\n' "$@" >> "$GUARD_LOG"
if [ "$1" = "ps" ]; then
  if [ -n "\${STUB_DIND_RUNNING:-}" ]; then printf '%s\\n' "$STUB_DIND_RUNNING"; fi
  exit 0
fi
exit "\${STUB_DOCKER_EXIT:-0}"
`

const SYSTEMCTL_STUB = `
printf 'CALL\\n' >> "$GUARD_LOG"
printf 'ARG[%s]\\n' "$@" >> "$GUARD_LOG"
exit 0
`

const INSTALL_STUB = `
printf 'CALL\\n' >> "$GUARD_LOG"
printf 'ARG[%s]\\n' "$@" >> "$GUARD_LOG"
exec /usr/bin/install "$@"
`

const DF_STUB = `
printf 'CALL\\n' >> "$GUARD_LOG"
printf 'ARG[%s]\\n' "$@" >> "$GUARD_LOG"
printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n'
printf '/dev/loop0 2097152 1900000 197152 %s%% /artifacts\\n' "\${STUB_DF_PERCENT:-50}"
`

interface Fixture {
  root: string
  stack: string
  bin: string
  meminfo: string
  log: string
  env: Record<string, string>
}

const created: string[] = []

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "openchat-guard-"))
  created.push(dir)
  return dir
}

function stub(bin: string, name: string, body: string): void {
  writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
}

/** The stack path contains a space on purpose: quoting is part of the contract. */
function fixture(availableMib = 3688): Fixture {
  const root = temp()
  const stack = join(root, "stack with space")
  const bin = join(root, "bin")
  mkdirSync(join(stack, "current"), { recursive: true })
  mkdirSync(join(stack, "disks", "artifacts"), { recursive: true })
  mkdirSync(bin)
  writeFileSync(join(stack, "current", "compose.yaml"), "services: {}\n")
  writeFileSync(join(stack, ".env"), "OPENCHAT_PASSWORD=x\n")

  const meminfo = join(root, "meminfo")
  writeMeminfo(meminfo, availableMib)

  stub(bin, "docker", DOCKER_STUB)
  stub(bin, "systemctl", SYSTEMCTL_STUB)
  stub(bin, "install", INSTALL_STUB)
  stub(bin, "df", DF_STUB)

  const log = join(root, "guard.log")
  writeFileSync(log, "")
  const env = { PATH: `${bin}:${process.env.PATH ?? ""}`, GUARD_LOG: log }
  return { root, stack, bin, meminfo, log, env }
}

function writeMeminfo(path: string, availableMib: number): void {
  const total = "MemTotal: 7831552 kB\nMemFree: 102400 kB\n"
  const swap = "SwapTotal: 16777212 kB\n"
  writeFileSync(path, `${total}MemAvailable: ${availableMib * 1024} kB\n${swap}`)
}

function run(script: string, args: string[], env: Record<string, string>) {
  return spawnSync("/bin/sh", [script, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  })
}

/** Each docker/systemctl/install call as its argv, from the stub's ARG lines. */
function calls(log: string): string[][] {
  const out: string[][] = []
  for (const block of readFileSync(log, "utf8").split("CALL\n")) {
    const args = block
      .split("\n")
      .filter((line) => line.startsWith("ARG["))
      .map((line) => line.slice(4, -1))
    if (args.length > 0) out.push(args)
  }
  return out
}

function composeCalls(log: string, verb: string): string[][] {
  return calls(log).filter(
    (args) => args[0] === "compose" && args.includes(verb) && args.includes("opencode"),
  )
}

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("ram-watchdog.sh", { timeout: 30_000 }, () => {
  it("stops opencode exactly once below --low, records 0600 state, and does not flap", () => {
    const f = fixture(500)
    const first = run(RAM, ["--stack-dir", f.stack, "--meminfo", f.meminfo], f.env)
    expect(first.status, first.stderr).toBe(0)
    expect(composeCalls(f.log, "stop")).toHaveLength(1)

    const state = join(f.stack, "ram-watchdog.state")
    expect(existsSync(state)).toBe(true)
    expect(statSync(state).mode & 0o777).toBe(0o600)
    expect(readFileSync(state, "utf8")).toContain("500 MiB")

    const second = run(RAM, ["--stack-dir", f.stack, "--meminfo", f.meminfo], f.env)
    expect(second.status, second.stderr).toBe(0)
    expect(composeCalls(f.log, "stop")).toHaveLength(1)
    expect(readFileSync(f.log, "utf8").match(/ARG\[stop\]/g)).toHaveLength(1)
  })

  it("starts opencode once above --high with state, removes state, then stays quiet", () => {
    const f = fixture(500)
    expect(run(RAM, ["--stack-dir", f.stack, "--meminfo", f.meminfo], f.env).status).toBe(0)

    writeMeminfo(f.meminfo, 2000)
    expect(run(RAM, ["--stack-dir", f.stack, "--meminfo", f.meminfo], f.env).status).toBe(0)
    expect(composeCalls(f.log, "start")).toHaveLength(1)
    expect(existsSync(join(f.stack, "ram-watchdog.state"))).toBe(false)

    expect(run(RAM, ["--stack-dir", f.stack, "--meminfo", f.meminfo], f.env).status).toBe(0)
    expect(composeCalls(f.log, "start")).toHaveLength(1)
    expect(composeCalls(f.log, "stop")).toHaveLength(1)
  })

  it("does nothing above --high when the state file is absent", () => {
    const f = fixture(2000)
    const result = run(RAM, ["--stack-dir", f.stack, "--meminfo", f.meminfo], f.env)
    expect(result.status).toBe(0)
    expect(calls(f.log)).toEqual([])
  })

  it("acts on the threshold inputs, not on a fixed number or the clock", () => {
    const band = fixture(1000)
    expect(run(RAM, ["--stack-dir", band.stack, "--meminfo", band.meminfo], band.env).status).toBe(0)
    expect(calls(band.log)).toEqual([])

    const custom = fixture(1000)
    const result = run(
      RAM,
      ["--stack-dir", custom.stack, "--meminfo", custom.meminfo, "--low", "1500", "--high", "1800"],
      custom.env,
    )
    expect(result.status).toBe(0)
    expect(composeCalls(custom.log, "stop")).toHaveLength(1)
  })

  it("logs and exits 0 when meminfo is missing or has no MemAvailable", () => {
    const f = fixture()
    const missing = run(
      RAM,
      ["--stack-dir", f.stack, "--meminfo", join(f.root, "absent")],
      f.env,
    )
    expect(missing.status).toBe(0)
    expect(missing.stderr).toContain("cannot read")
    expect(calls(f.log)).toEqual([])

    writeFileSync(f.meminfo, "MemTotal: 100 kB\n")
    const corrupt = run(RAM, ["--stack-dir", f.stack, "--meminfo", f.meminfo], f.env)
    expect(corrupt.status).toBe(0)
    expect(corrupt.stderr).toContain("MemAvailable")
    expect(calls(f.log)).toEqual([])
  })

  it("logs and exits 0 when the compose file is missing", () => {
    const f = fixture(100)
    rmSync(join(f.stack, "current", "compose.yaml"))
    const result = run(RAM, ["--stack-dir", f.stack, "--meminfo", f.meminfo], f.env)
    expect(result.status).toBe(0)
    expect(result.stderr).toContain("no compose file")
    expect(calls(f.log)).toEqual([])
  })

  it("--dry-run prints the action and changes nothing", () => {
    const f = fixture(100)
    const result = run(RAM, ["--stack-dir", f.stack, "--meminfo", f.meminfo, "--dry-run"], f.env)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("would: stop the opencode service")
    expect(calls(f.log)).toEqual([])
    expect(existsSync(join(f.stack, "ram-watchdog.state"))).toBe(false)
  })

  it("passes a space-bearing --stack-dir to docker as single argv words", () => {
    const f = fixture(100)
    expect(run(RAM, ["--stack-dir", f.stack, "--meminfo", f.meminfo], f.env).status).toBe(0)
    const stop = composeCalls(f.log, "stop")[0]
    expect(stop).toContain(join(f.stack, "current", "compose.yaml"))
    expect(stop).toContain(join(f.stack, ".env"))
    expect(stop).toContain("opencode")
  })

  it("rejects a backwards threshold pair as a usage error", () => {
    const f = fixture()
    const result = run(RAM, ["--stack-dir", f.stack, "--low", "1200", "--high", "900"], f.env)
    expect(result.status).toBe(2)
    expect(result.stderr).toContain("greater than --low")
    expect(calls(f.log)).toEqual([])
  })
})

describe("dind-gc.sh", { timeout: 30_000 }, () => {
  it("exits 0 without pruning when the dind service is not running", () => {
    const f = fixture()
    const result = run(DIND, [], f.env)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("not running")
    const cs = calls(f.log)
    expect(cs).toHaveLength(1)
    expect(cs[0]?.[0]).toBe("ps")
    expect(cs.some((args) => args.includes("prune"))).toBe(false)
  })

  it("prunes on the internal network with a bounded age when dind runs", () => {
    const f = fixture()
    const result = run(DIND, ["--max-age-hours", "24"], { ...f.env, STUB_DIND_RUNNING: "dind-id" })
    expect(result.status).toBe(0)
    const prune = calls(f.log).find((args) => args.includes("prune"))
    expect(prune).toBeDefined()
    expect(prune).toEqual([
      "run",
      "--rm",
      "--network",
      "openchat_dind",
      "-e",
      "DOCKER_HOST=tcp://dind:2375",
      "--entrypoint",
      "docker",
      "docker:27-dind-rootless@sha256:e2ac8e8f66ae21a060b0a8e3005c70f6ed9441aabf409434463d1f6eecd38026",
      "image",
      "prune",
      "-af",
      "--filter",
      "until=24h",
    ])
  })

  it("--dry-run prints the one-shot command and runs no container", () => {
    const f = fixture()
    const result = run(DIND, ["--dry-run"], { ...f.env, STUB_DIND_RUNNING: "dind-id" })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("would: docker run")
    expect(calls(f.log).some((args) => args.includes("run"))).toBe(false)
  })
})

describe("artifact-usage.sh", { timeout: 30_000 }, () => {
  it("warns at 91 % and stays silent at 50 %", () => {
    const f = fixture()
    const high = run(ARTIFACTS, ["--stack-dir", f.stack], { ...f.env, STUB_DF_PERCENT: "91" })
    expect(high.status).toBe(0)
    expect(high.stdout).toContain("WARNING: artifacts disk 91% used")
    expect(high.stdout).toContain("no files were deleted")

    const low = run(ARTIFACTS, ["--stack-dir", f.stack], { ...f.env, STUB_DF_PERCENT: "50" })
    expect(low.status).toBe(0)
    expect(low.stdout).not.toContain("WARNING")
  })

  it("exits 0 when the artifacts disk is not mounted", () => {
    const f = fixture()
    rmSync(join(f.stack, "disks", "artifacts"), { recursive: true, force: true })
    const result = run(ARTIFACTS, ["--stack-dir", f.stack], f.env)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("nothing to check")
  })
})

describe("install.sh", { timeout: 30_000 }, () => {
  it("installs scripts, renders units and enables the timers, then reverses it", () => {
    const f = fixture()
    const units = join(f.root, "units")
    const install = run(INSTALL, ["--stack-dir", f.stack, "--unit-dir", units], f.env)
    expect(install.status, install.stderr).toBe(0)

    for (const name of ["ram-watchdog.sh", "dind-gc.sh", "artifact-usage.sh"]) {
      const path = join(f.stack, "bin", name)
      expect(existsSync(path), name).toBe(true)
      expect(statSync(path).mode & 0o111).not.toBe(0)
    }
    for (const unit of [
      "openchat-ram-watchdog.service",
      "openchat-ram-watchdog.timer",
      "openchat-dind-gc.service",
      "openchat-dind-gc.timer",
      "openchat-artifact-usage.service",
      "openchat-artifact-usage.timer",
    ]) {
      const text = readFileSync(join(units, unit), "utf8")
      expect(text, unit).not.toContain("@STACK_DIR@")
      if (text.includes("/bin/")) expect(text).toContain(f.stack)
    }

    const enabled = calls(f.log).filter((args) => args[0] === "enable")
    expect(enabled.map((args) => args[2])).toEqual([
      "openchat-ram-watchdog.timer",
      "openchat-dind-gc.timer",
      "openchat-artifact-usage.timer",
    ])
    expect(calls(f.log).some((args) => args[0] === "docker")).toBe(false)

    const state = join(f.stack, "ram-watchdog.state")
    writeFileSync(state, "kept\n")
    const remove = run(INSTALL, ["--stack-dir", f.stack, "--unit-dir", units, "--uninstall"], f.env)
    expect(remove.status, remove.stderr).toBe(0)
    expect(remove.stdout).toContain("kept on purpose")
    expect(existsSync(state)).toBe(true)
    expect(existsSync(join(f.stack, "bin", "ram-watchdog.sh"))).toBe(false)
    expect(existsSync(join(units, "openchat-ram-watchdog.timer"))).toBe(false)
    const disabled = calls(f.log).filter((args) => args[0] === "disable")
    expect(disabled).toHaveLength(3)
  })

  it("--dry-run changes nothing", () => {
    const f = fixture()
    const units = join(f.root, "units")
    const result = run(
      INSTALL,
      ["--stack-dir", f.stack, "--unit-dir", units, "--dry-run"],
      f.env,
    )
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("would: install")
    expect(existsSync(join(f.stack, "bin"))).toBe(false)
    expect(existsSync(units)).toBe(false)
    expect(calls(f.log)).toEqual([])
  })
})

describe("units and documentation", () => {
  it("keeps the guards independent of docker.service and free of OnFailure handlers", () => {
    for (const name of [
      "openchat-ram-watchdog.service",
      "openchat-dind-gc.service",
      "openchat-artifact-usage.service",
    ]) {
      const text = readFileSync(join(HOST, name), "utf8")
      expect(text, name).not.toMatch(/^(After|Before|Requires|Wants|BindsTo)=.*docker\.service/m)
      expect(text, name).not.toMatch(/^OnFailure=/m)
    }
  })

  it("documents the measured baseline, thresholds and the unproven parts", () => {
    const text = readFileSync(join(ROOT, "docs", "implementation", "14-deployment.md"), "utf8")
    expect(text).toContain("deploy/host/")
    expect(text).toContain("MemAvailable")
    expect(text).toContain("900 MiB")
    expect(text).toContain("1200 MiB")
    expect(text.toLowerCase()).toContain("unproven")
  })
})
