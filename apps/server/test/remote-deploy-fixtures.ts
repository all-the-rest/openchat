import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

/**
 * Shared fixtures for the remote deploy hardening tests: temp dirs, PATH stubs
 * and text helpers. Nothing here starts a container, opens SSH or needs root.
 */

export const ROOT = resolve(import.meta.dirname, "..", "..", "..")
export const DEPLOY = join(ROOT, "deploy", "remote", "deploy.sh")
export const CADDY_SH = join(ROOT, "deploy", "remote", "caddy.sh")
export const DISKS = join(ROOT, "deploy", "remote", "mount-disks.sh")

const created: string[] = []

export function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  created.push(dir)
  return dir
}

export function cleanupTemp(): void {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
}

export function stub(bin: string, name: string, body: string, shebang = "#!/usr/bin/env bash"): void {
  writeFileSync(join(bin, name), `${shebang}\n${body}\n`, { mode: 0o755 })
}

export function run(
  script: string,
  args: string[],
  env: Record<string, string> = {},
  options: { cwd?: string } = {},
) {
  return spawnSync("/bin/bash", [script, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    cwd: options.cwd,
  })
}

/** One `  name:` service block of a compose file, as raw text. */
export function serviceBlock(text: string, name: string): string {
  const start = text.indexOf(`\n  ${name}:\n`)
  const rest = start < 0 ? "" : text.slice(start + 1)
  const next = rest.search(/\n  [A-Za-z0-9_-]+:\n/)
  if (start < 0) throw new Error(`compose file has no service ${name}`)
  return next === -1 ? rest : rest.slice(0, next)
}

/** A block that starts at `start` and ends at the next line that is `close`. */
export function block(text: string, start: string, close: string): string {
  const from = text.indexOf(start)
  const to = text.indexOf(close, from + start.length)
  if (from < 0 || to <= from) throw new Error(`block ${start} not found`)
  return text.slice(from, to)
}
