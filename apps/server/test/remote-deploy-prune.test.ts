import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { DEPLOY, ROOT, cleanupTemp, run, stub, temp } from "./remote-deploy-fixtures"

/**
 * Follow-up 8 of #43: a rollback needs `current` and `previous`, not every
 * release ever built. The prune keeps those two (and their tags), drops older
 * release dirs, `src/<tag>` trees and `openchat-*:<tag>` images, and refuses to
 * guess when a kept release predates the recorded `tag` file.
 *
 * A fake `docker` answers `image ls` from a fixture and records `rmi`; nothing
 * is pulled or removed on a real daemon.
 */

const PRUNE = join(ROOT, "deploy", "remote", "prune-releases.sh")

const OLD = "20260101T000000Z"
const PREVIOUS = "20260201T000000Z"
const CURRENT = "20260301T000000Z"
const OLD_TAG = "aaa1111"
const PREVIOUS_TAG = "bbb2222"
const CURRENT_TAG = "ccc3333"

const IMAGES = [
  `openchat-bff:${OLD_TAG}`,
  `openchat-code-host:${OLD_TAG}`,
  `openchat-bff:${PREVIOUS_TAG}`,
  `openchat-bff:${CURRENT_TAG}`,
  "openchat-bff:latest",
  `otherapp:${OLD_TAG}`,
  `ghcr.io/example/openchat-bff:${OLD_TAG}`,
]

const DOCKER_STUB = `
printf '%s\\n' "$*" >> "$DOCKER_LOG"
if [ "$1" = "image" ] && [ "$2" = "ls" ]; then
  cat "$DOCKER_REFS"
fi
exit 0
`

interface Fixture {
  root: string
  stack: string
  log: string
  env: Record<string, string>
}

function release(stack: string, name: string, tag: string): void {
  const dir = join(stack, "releases", name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "compose.yaml"), "services: {}\n")
  writeFileSync(join(dir, "tag"), `${tag}\n`)
}

function sourceTree(stack: string, tag: string): void {
  const dir = join(stack, "src", tag)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "marker"), tag)
}

function fixture(stackName = "stack"): Fixture {
  const root = temp("openchat-prune-")
  const stack = join(root, stackName)
  const bin = join(root, "bin")
  mkdirSync(bin)
  stub(bin, "docker", DOCKER_STUB, "#!/bin/sh")

  release(stack, OLD, OLD_TAG)
  release(stack, PREVIOUS, PREVIOUS_TAG)
  release(stack, CURRENT, CURRENT_TAG)
  for (const tag of [OLD_TAG, PREVIOUS_TAG, CURRENT_TAG]) sourceTree(stack, tag)
  symlinkSync(`releases/${CURRENT}`, join(stack, "current"))
  symlinkSync(`releases/${PREVIOUS}`, join(stack, "previous"))

  const refs = join(root, "images.txt")
  writeFileSync(refs, `${IMAGES.join("\n")}\n`)
  const log = join(root, "docker.log")
  writeFileSync(log, "")

  return {
    root,
    stack,
    log,
    env: {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      DOCKER_LOG: log,
      DOCKER_REFS: refs,
    },
  }
}

function logLines(test: Fixture): string[] {
  return readFileSync(test.log, "utf8").split("\n").filter(Boolean)
}

function rmiRefs(test: Fixture): string[] {
  return logLines(test)
    .filter((line) => line.startsWith("rmi "))
    .map((line) => line.slice("rmi ".length))
}

afterEach(cleanupTemp)

describe("release retention", { timeout: 30_000 }, () => {
  it("keeps current and previous, removes the old release, source tree and tags", () => {
    const test = fixture()
    const result = run(PRUNE, ["--stack-dir", test.stack], test.env)
    expect(result.status, result.stderr).toBe(0)

    expect(existsSync(join(test.stack, "releases", OLD))).toBe(false)
    for (const kept of [CURRENT, PREVIOUS]) {
      expect(existsSync(join(test.stack, "releases", kept, "tag"))).toBe(true)
    }
    expect(existsSync(join(test.stack, "src", OLD_TAG))).toBe(false)
    for (const kept of [CURRENT_TAG, PREVIOUS_TAG]) {
      expect(existsSync(join(test.stack, "src", kept))).toBe(true)
    }

    expect(rmiRefs(test)).toEqual([`openchat-bff:${OLD_TAG}`, `openchat-code-host:${OLD_TAG}`])
    const log = logLines(test).join("\n")
    // `latest`, another repository and a path-like repository are untouched.
    expect(log).not.toContain("openchat-bff:latest")
    expect(log).not.toContain(`otherapp:${OLD_TAG}`)
    expect(log).not.toContain(`ghcr.io/example/openchat-bff:${OLD_TAG}`)
    expect(result.stdout).toContain("retention: removed 1 release(s), 1 source tree(s) and 2 image(s)")
  })

  it("deletes nothing when the previous release has no tag file", () => {
    const test = fixture()
    rmSync(join(test.stack, "releases", PREVIOUS, "tag"))

    const result = run(PRUNE, ["--stack-dir", test.stack], test.env)
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain("nothing is deleted")

    expect(existsSync(join(test.stack, "releases", OLD))).toBe(true)
    expect(existsSync(join(test.stack, "src", OLD_TAG))).toBe(true)
    expect(rmiRefs(test)).toEqual([])
  })

  it("deletes nothing when there is no previous release", () => {
    const test = fixture()
    rmSync(join(test.stack, "previous"))

    const result = run(PRUNE, ["--stack-dir", test.stack], test.env)
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain("no previous release")
    expect(existsSync(join(test.stack, "releases", OLD))).toBe(true)
    expect(rmiRefs(test)).toEqual([])
  })

  it("prints a dry run and deletes nothing", () => {
    const test = fixture()
    const result = run(PRUNE, ["--stack-dir", test.stack, "--dry-run"], test.env)
    expect(result.status, result.stderr).toBe(0)

    expect(result.stdout).toContain("would: rm -rf")
    expect(result.stdout).toContain("would: docker rmi")
    expect(result.stdout).toContain("dry run:")
    expect(existsSync(join(test.stack, "releases", OLD))).toBe(true)
    expect(existsSync(join(test.stack, "src", OLD_TAG))).toBe(true)
    expect(rmiRefs(test)).toEqual([])
  })

  it("keeps more releases with --keep 3 and still drops the rest", () => {
    const test = fixture()
    release(test.stack, "20251201T000000Z", "ddd4444")
    sourceTree(test.stack, "ddd4444")

    const result = run(PRUNE, ["--stack-dir", test.stack, "--keep", "3"], test.env)
    expect(result.status, result.stderr).toBe(0)
    expect(existsSync(join(test.stack, "releases", OLD))).toBe(true)
    expect(existsSync(join(test.stack, "src", OLD_TAG))).toBe(true)
    expect(existsSync(join(test.stack, "releases", "20251201T000000Z"))).toBe(false)
    expect(existsSync(join(test.stack, "src", "ddd4444"))).toBe(false)
  })

  it("treats a hostile --stack-dir as one inert word", () => {
    const root = temp("openchat-prune-")
    const marker = join(root, "pwned")
    const stack = join(root, "s; touch pwned; #")
    const bin = join(root, "bin")
    mkdirSync(bin)
    stub(bin, "docker", DOCKER_STUB, "#!/bin/sh")
    release(stack, OLD, OLD_TAG)
    release(stack, PREVIOUS, PREVIOUS_TAG)
    release(stack, CURRENT, CURRENT_TAG)
    for (const tag of [OLD_TAG, PREVIOUS_TAG, CURRENT_TAG]) sourceTree(stack, tag)
    symlinkSync(`releases/${CURRENT}`, join(stack, "current"))
    symlinkSync(`releases/${PREVIOUS}`, join(stack, "previous"))
    const refs = join(root, "images.txt")
    writeFileSync(refs, "")
    const log = join(root, "docker.log")
    writeFileSync(log, "")

    const result = run(PRUNE, ["--stack-dir", stack], {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      DOCKER_LOG: log,
      DOCKER_REFS: refs,
    })
    expect(result.status, result.stderr).toBe(0)
    expect(existsSync(marker), "the injected touch must not run").toBe(false)
    expect(existsSync(join(stack, "releases", OLD))).toBe(false)
  })

  it("is wired after the swap and Caddy, and records the tag per release", () => {
    const test = fixture()
    const dry = run(DEPLOY, ["--dry-run", "--tag", "abc1234"], test.env)
    expect(dry.status, dry.stderr).toBe(0)

    const prune = dry.stdout.indexOf("prune-releases.sh")
    expect(prune).toBeGreaterThan(dry.stdout.indexOf("deploy/swap.sh"))
    expect(prune).toBeGreaterThan(dry.stdout.indexOf("'--fragment'"))
    expect(prune).toBeLessThan(dry.stdout.indexOf("docker builder prune"))

    const deploy = readFileSync(DEPLOY, "utf8")
    expect(deploy).toContain('printf \'%s\\n\' $(shquote "$TAG") > $(shquote "$RELEASE/tag")')
    expect(deploy).toContain('chmod 644 $(shquote "$RELEASE/tag")')
  })
})
