import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { DEPLOY, ROOT, cleanupTemp, run, stub, temp } from "./remote-deploy-fixtures"

/**
 * Findings 1 and 2 of the #43 follow-ups: a failed mount must stop this stack
 * and only this stack. The guard runs after Docker (whose `restart:
 * unless-stopped` does not re-evaluate `depends_on`) and stops the `openchat`
 * compose project when a disk marker is missing.
 *
 * A fake `docker` records its argv; no daemon, container or systemd is touched.
 */

const GUARD = join(ROOT, "deploy", "remote", "openchat-guard.sh")
const GUARD_UNIT = join(ROOT, "deploy", "remote", "openchat-guard.service")

const DOCKER_STUB = `
{
  for arg in "$@"; do printf '%s\\037' "$arg"; done
  printf '\\n'
} >> "$DOCKER_LOG"
exit "\${STUB_DOCKER_STATUS:-0}"
`

interface Fixture {
  root: string
  stack: string
  log: string
  env: Record<string, string>
}

function fixture(name = "stack"): Fixture {
  const root = temp("openchat-guard-")
  const bin = join(root, "bin")
  mkdirSync(bin)
  stub(bin, "docker", DOCKER_STUB, "#!/bin/sh")

  const stack = join(root, name)
  for (const disk of ["artifacts", "workspace", "dind", "memory"]) {
    mkdirSync(join(stack, "disks", disk), { recursive: true })
    writeFileSync(join(stack, "disks", disk, ".openchat-disk"), `${disk}\n`)
  }
  mkdirSync(join(stack, "current"), { recursive: true })
  writeFileSync(join(stack, "current", "compose.yaml"), "services: {}\n")
  writeFileSync(join(stack, ".env"), "SENTINEL=1\n")

  const log = join(root, "docker.log")
  writeFileSync(log, "")
  return {
    root,
    stack,
    log,
    env: { PATH: `${bin}:${process.env.PATH ?? ""}`, DOCKER_LOG: log },
  }
}

function calls(test: Fixture): string[][] {
  return readFileSync(test.log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\u001f").filter((part) => part.length > 0))
}

afterEach(cleanupTemp)

describe("boot guard", { timeout: 30_000 }, () => {
  it("exits silently and starts nothing when every marker is present", () => {
    const test = fixture()
    const result = run(GUARD, ["--stack-dir", test.stack], test.env)

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toBe("")
    expect(result.stderr).toBe("")
    expect(calls(test)).toEqual([])
  })

  it("stops only the openchat project, with a space-bearing stack dir as one word", () => {
    const test = fixture("stack dir")
    const missing = join(test.stack, "disks", "workspace", ".openchat-disk")
    // Remove exactly one marker: the other two stay.
    rmSync(missing)

    const result = run(GUARD, ["--stack-dir", test.stack], test.env)
    expect(result.status, result.stderr).toBe(0)
    expect(result.stderr).toContain(missing)

    expect(calls(test)).toEqual([
      [
        "compose",
        "--project-name",
        "openchat",
        "--env-file",
        join(test.stack, ".env"),
        "--file",
        join(test.stack, "current", "compose.yaml"),
        "--profile",
        "*",
        "stop",
      ],
    ])
    // The space in the stack dir must not split any recorded argument.
    expect(calls(test)[0]).toContain(join(test.stack, ".env"))
  })

  it("logs a failed compose stop, still exits 0 and never fails the boot", () => {
    const test = fixture()
    rmSync(join(test.stack, "disks", "dind", ".openchat-disk"))

    const result = run(GUARD, ["--stack-dir", test.stack], { ...test.env, STUB_DOCKER_STATUS: "1" })
    expect(result.status).toBe(0)
    expect(result.stderr).toContain("docker compose stop failed")
  })

  it("does not call docker when the compose file or .env is missing", () => {
    for (const missing of ["current/compose.yaml", ".env"]) {
      const test = fixture()
      rmSync(join(test.stack, "disks", "artifacts", ".openchat-disk"))
      rmSync(join(test.stack, missing))

      const result = run(GUARD, ["--stack-dir", test.stack], test.env)
      expect(result.status, `missing ${missing}`).toBe(0)
      expect(result.stderr).toContain(missing)
      expect(calls(test), `no docker call for missing ${missing}`).toEqual([])
    }
  })

  it("prints the stop command in a dry run and calls nothing", () => {
    const test = fixture()
    rmSync(join(test.stack, "disks", "artifacts", ".openchat-disk"))

    const result = run(GUARD, ["--stack-dir", test.stack, "--dry-run"], test.env)
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain("would: docker compose")
    expect(result.stdout).toContain('--profile "*" stop')
    expect(calls(test)).toEqual([])
  })

  it("is ordered after docker and never makes docker require it", () => {
    const unit = readFileSync(GUARD_UNIT, "utf8")
    expect(unit).toMatch(/^Type=oneshot$/m)
    expect(unit).toMatch(/^After=docker\.service$/m)
    expect(unit).toMatch(/^Wants=docker\.service$/m)
    expect(unit).toContain(
      "ExecStart=/opt/stacks/openchat/bin/openchat-guard.sh --stack-dir /opt/stacks/openchat",
    )
    expect(unit).toMatch(/^WantedBy=multi-user\.target$/m)
    expect(unit).not.toMatch(/^Requires=docker\.service$/m)
    // The explanation for the deliberate absence lives in the unit.
    expect(unit).toContain("never")
    expect(unit).toContain("docker.service.d")
  })

  it("adds no docker.service drop-in anywhere in the deploy layer", () => {
    const files: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry)
        if (statSync(path).isDirectory()) walk(path)
        else files.push(path)
      }
    }
    walk(join(ROOT, "deploy"))

    for (const file of files) {
      // A comment cannot add a dependency; inspect the effective lines only.
      const text = readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => !/^\s*#/.test(line))
        .join("\n")
      expect(text, `${file} must not add a docker drop-in`).not.toContain("docker.service.d")
      expect(text, `${file} must not require docker.service`).not.toMatch(
        /^Requires=docker\.service$/m,
      )
    }
  })

  it("installs and enables the guard, and removes it on --uninstall", () => {
    const deploy = readFileSync(DEPLOY, "utf8")
    expect(deploy).toContain(
      'install -m 755 "$SRC/deploy/remote/openchat-guard.sh" "$STACK_DIR/bin/openchat-guard.sh"',
    )
    expect(deploy).toContain(
      'install -m 644 "$SRC/deploy/remote/openchat-guard.service" /etc/systemd/system/openchat-guard.service',
    )
    expect(deploy).toContain("systemctl enable openchat-disks.service openchat-guard.service")
    expect(deploy).toContain(
      "systemctl disable --now openchat-disks.service openchat-guard.service",
    )
    expect(deploy).toContain(
      "rm -f /etc/systemd/system/openchat-disks.service /etc/systemd/system/openchat-guard.service",
    )
  })
})
