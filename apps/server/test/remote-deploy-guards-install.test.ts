import { readFileSync } from "node:fs"
import { afterEach, describe, expect, it } from "vitest"
import { DEPLOY, cleanupTemp, run } from "./remote-deploy-fixtures"

/**
 * `--with-guards` wires `deploy/host/install.sh` into the deploy and makes
 * `--uninstall` take the guard timers back out. The guards themselves are
 * pinned by `host-guards.test.ts`; this file pins the driver.
 */

const TIMERS = ["openchat-ram-watchdog.timer", "openchat-dind-gc.timer", "openchat-artifact-usage.timer"]
const SERVICES = ["openchat-ram-watchdog.service", "openchat-dind-gc.service", "openchat-artifact-usage.service"]

afterEach(cleanupTemp)

function deployText(): string {
  return readFileSync(DEPLOY, "utf8")
}

describe("--with-guards", () => {
  it("runs the host installer from the synced tree after the Caddy fragment", () => {
    const result = run(DEPLOY, ["--dry-run", "--tag", "abc1234", "--with-guards"])
    expect(result.status, result.stderr).toBe(0)

    const guards = result.stdout.indexOf("deploy/host/install.sh")
    expect(guards).toBeGreaterThan(0)
    expect(result.stdout).toContain("--stack-dir '/opt/stacks/openchat'")
    expect(result.stdout).toContain("/src/abc1234/deploy/host/install.sh")
    expect(guards).toBeGreaterThan(result.stdout.indexOf("deploy/remote/caddy.sh"))
    expect(result.stdout, "nothing is claimed in a dry run").not.toContain("host guards installed")
  })

  it("is off by default", () => {
    const result = run(DEPLOY, ["--dry-run", "--tag", "abc1234"])
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).not.toContain("deploy/host/install.sh")
  })

  it("refuses anything but a deploy", () => {
    for (const action of ["--uninstall", "--unmount"]) {
      const result = run(DEPLOY, ["--with-guards", action])
      expect(result.status, result.stderr).toBe(2)
      expect(result.stderr).toContain("--with-guards only applies to a deploy")
    }
  })

  it("is not fatal after a completed swap", () => {
    const text = deployText()
    expect(text).toContain("warning: host guard install failed; the deploy is unaffected")
    expect(text).toMatch(/if remote "sh .*install\.sh"[^\n]*; then/)
  })

  it("preflights the host installer and its scripts", () => {
    const text = deployText()
    for (const file of ["deploy/host/install.sh", "deploy/host/ram-watchdog.sh", "deploy/host/dind-gc.sh", "deploy/host/artifact-usage.sh"]) {
      expect(text, `${file} must be a required file`).toContain(file)
    }
  })
})

describe("--uninstall", () => {
  it("disables and removes the guard timers and units", () => {
    const result = run(DEPLOY, ["--dry-run", "--uninstall"])
    expect(result.status, result.stderr).toBe(0)

    const planned = result.stdout
    const disableAt = planned.indexOf("systemctl disable --now")
    expect(disableAt, "the units must be disabled, not only deleted").toBeGreaterThan(0)
    const disabled = planned.slice(disableAt, planned.indexOf("2>/dev/null", disableAt))

    for (const timer of TIMERS) {
      expect(disabled, `systemctl disable must name ${timer}`).toContain(timer)
    }
    for (const unit of [...TIMERS, ...SERVICES]) {
      expect(planned, `the unit file must be removed: ${unit}`).toContain(`/etc/systemd/system/${unit}`)
    }
    expect(planned).toContain("ram-watchdog.state")
  })
})
