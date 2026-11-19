import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { DISKS, cleanupTemp, run, stub, temp } from "./remote-deploy-fixtures"

/**
 * Findings 4, 5 and 10: a failed `mkfs` must not leave a trusted image, a bad
 * size must be a usage error before any arithmetic, and the mount roots must be
 * chowned after mounting (also on the already-mounted rerun).
 */

const MKFS_STUB = `
printf 'mkfs %s\\n' "$*" >> "$DISK_LOG"
[ -n "\${STUB_MKFS_FAIL:-}" ] && exit 1
exit 0
`

const MOUNT_STUB = `
printf 'mount %s\\n' "$*" >> "$DISK_LOG"
exit 0
`

const MOUNTPOINT_STUB = `exit "\${STUB_MOUNTED:-1}"`

const CHOWN_STUB = `
printf 'chown %s\\n' "$*" >> "$DISK_LOG"
[ -n "\${STUB_CHOWN_FAIL:-}" ] && exit 1
exit 0
`

const TRUNCATE_STUB = `exec /usr/bin/truncate "$@"`

interface Fixture {
  stack: string
  log: string
  env: Record<string, string>
}

function fixture(): Fixture {
  const root = temp("openchat-disk-")
  const stack = join(root, "stack")
  const bin = join(root, "bin")
  mkdirSync(stack, { recursive: true })
  mkdirSync(bin)
  stub(bin, "mkfs.ext4", MKFS_STUB)
  stub(bin, "mount", MOUNT_STUB)
  stub(bin, "mountpoint", MOUNTPOINT_STUB)
  stub(bin, "chown", CHOWN_STUB)
  stub(bin, "truncate", TRUNCATE_STUB)
  const log = join(root, "disk.log")
  writeFileSync(log, "")
  return { stack, log, env: { PATH: `${bin}:${process.env.PATH ?? ""}`, DISK_LOG: log } }
}

function lines(log: string): string[] {
  return readFileSync(log, "utf8").split("\n").filter(Boolean)
}

afterEach(cleanupTemp)

describe("mount-disks.sh failure paths", { timeout: 60_000 }, () => {
  it("does not trust a 0-byte image after a failed mkfs, on either run", () => {
    const test = fixture()
    const env = { ...test.env, STUB_MKFS_FAIL: "1" }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = run(DISKS, ["--stack-dir", test.stack], env)
      expect(result.status, `attempt ${attempt + 1}`).not.toBe(0)
      expect(result.stderr).toContain("mkfs.ext4 failed")
      expect(existsSync(join(test.stack, "disks", "artifacts.img"))).toBe(false)
      expect(existsSync(join(test.stack, "disks", "artifacts.img.tmp"))).toBe(false)
      expect(lines(test.log).filter((line) => line.startsWith("mount "))).toEqual([])
    }
  })

  it("rejects every malformed size with a readable message, not arithmetic", () => {
    const test = fixture()
    const flags = ["--artifacts-size", "--workspace-size", "--dind-size", "--reserve"]
    for (const flag of flags) {
      for (const value of ["2X", "0G", "2", "2GG", "G"]) {
        const result = run(DISKS, ["--stack-dir", test.stack, flag, value], test.env)
        expect(result.status, `${flag} ${value}`).toBe(2)
        expect(result.stderr).toMatch(/must be (a number with|positive)/)
        expect(result.stderr).not.toMatch(/syntax error/)
      }
    }
  })

  it("chowns each mount root after the mount and again on an already-mounted run", () => {
    const fresh = fixture()
    const first = run(DISKS, ["--stack-dir", fresh.stack], fresh.env)
    expect(first.status, first.stderr).toBe(0)
    const firstLog = lines(fresh.log)
    for (const name of ["artifacts", "workspace", "dind"]) {
      const mount = firstLog.findIndex(
        (line) => line.startsWith("mount -o loop") && line.endsWith(`/${name}`),
      )
      const chown = firstLog.findIndex(
        (line) => line.startsWith("chown 1000:1000 ") && line.endsWith(`/disks/${name}`),
      )
      expect(mount, `${name} must be mounted`).toBeGreaterThanOrEqual(0)
      expect(chown, `${name} must be chowned after the mount`).toBeGreaterThan(mount)
      expect(readFileSync(join(fresh.stack, "disks", name, ".openchat-disk"), "utf8")).toBe(`${name}\n`)
    }

    const mounted = fixture()
    mkdirSync(join(mounted.stack, "disks"), { recursive: true })
    for (const name of ["artifacts", "workspace", "dind"]) {
      writeFileSync(join(mounted.stack, "disks", `${name}.img`), "")
      mkdirSync(join(mounted.stack, "disks", name), { recursive: true })
    }
    const second = run(DISKS, ["--stack-dir", mounted.stack], { ...mounted.env, STUB_MOUNTED: "0" })
    expect(second.status, second.stderr).toBe(0)
    const secondLog = lines(mounted.log)
    expect(secondLog.filter((line) => line.startsWith("mount "))).toEqual([])
    for (const name of ["artifacts", "workspace", "dind"]) {
      expect(
        secondLog.some(
          (line) => line.startsWith("chown 1000:1000 ") && line.endsWith(`/disks/${name}`),
        ),
        `${name} must be chowned on the already-mounted branch`,
      ).toBe(true)
    }  })

  it("creates and chowns the chat-files subtree inside the workspace disk", () => {
    const test = fixture()
    const result = run(DISKS, ["--stack-dir", test.stack], test.env)
    expect(result.status, result.stderr).toBe(0)
    const log = lines(test.log)
    const mount = log.findIndex(
      (line) => line.startsWith("mount -o loop") && line.endsWith("/workspace"),
    )
    const chown = log.findIndex(
      (line) =>
        line.startsWith("chown 1000:1000 ") && line.endsWith("/disks/workspace/chats"),
    )
    // The BFF mounts this path as a nested bind and must own it (issue #25).
    expect(existsSync(join(test.stack, "disks", "workspace", "chats"))).toBe(true)
    expect(mount, "the workspace must be mounted first").toBeGreaterThanOrEqual(0)
    expect(chown, "chats must be chowned after the workspace mount").toBeGreaterThan(mount)
  })

  it("creates the memory mountpoint inside the workspace disk for the nested bind", () => {
    const test = fixture()
    const result = run(DISKS, ["--stack-dir", test.stack], test.env)
    expect(result.status, result.stderr).toBe(0)
    const log = lines(test.log)
    const mount = log.findIndex(
      (line) => line.startsWith("mount -o loop") && line.endsWith("/workspace"),
    )
    const chown = log.findIndex(
      (line) =>
        line.startsWith("chown 1000:1000 ") && line.endsWith("/disks/workspace/.memory"),
    )
    // `disks/memory` is bound over `/workspace/.memory` on top of the read-only
    // workspace bind, so Docker cannot create the mountpoint itself; it must
    // already exist on the workspace disk, owned by the BFF uid and mode 0700
    // like the image (deploy/Dockerfile.bff).
    const target = join(test.stack, "disks", "workspace", ".memory")
    expect(existsSync(target)).toBe(true)
    expect(statSync(target).mode & 0o777).toBe(0o700)
    expect(mount, "the workspace must be mounted first").toBeGreaterThanOrEqual(0)
    expect(chown, ".memory must be chowned after the workspace mount").toBeGreaterThan(mount)
  })

  it("stops before starting the next disk when a chown fails", () => {
    const test = fixture()
    const result = run(DISKS, ["--stack-dir", test.stack], { ...test.env, STUB_CHOWN_FAIL: "1" })
    expect(result.status).not.toBe(0)
    expect(lines(test.log).filter((line) => line.startsWith("chown "))).toHaveLength(1)
    expect(lines(test.log).some((line) => line.endsWith("/workspace"))).toBe(false)
  })
})
