import { spawnSync } from "node:child_process"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { ROOT } from "./remote-deploy-fixtures"

/**
 * The deploy driver's build set and its disk hygiene (issue #44): `toolbox` is
 * a dind-only image, and the shared BuildKit cache is trimmed after a swap.
 */

const DEPLOY_SH = join(ROOT, "deploy", "remote", "deploy.sh")

function dryRun(extra: string[] = []) {
  return spawnSync("/bin/bash", [DEPLOY_SH, "--dry-run", "--tag", "abc1234", ...extra], {
    encoding: "utf8",
  })
}

describe("image build set", () => {
  it("builds the toolbox image only for the dind profile", () => {
    const plain = dryRun()
    const withDind = dryRun(["--with-dind"])

    expect(plain.status).toBe(0)
    expect(withDind.status).toBe(0)
    expect(plain.stdout).toContain(
      "'build' 'bff' 'code-host' 'artifact-host' 'opencode'\n",
    )
    expect(plain.stdout).not.toContain("'toolbox'")
    expect(withDind.stdout).toContain(
      "'build' 'bff' 'code-host' 'artifact-host' 'opencode' 'toolbox'",
    )
  })

  it("trims the shared build cache only after the swap succeeded", () => {
    const result = dryRun()

    expect(result.status).toBe(0)
    const swap = result.stdout.indexOf("deploy/swap.sh")
    const prune = result.stdout.indexOf("docker builder prune -f --keep-storage 4GB")
    expect(swap).toBeGreaterThan(-1)
    expect(prune).toBeGreaterThan(swap)
  })
})
