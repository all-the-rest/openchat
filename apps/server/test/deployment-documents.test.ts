import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"

/**
 * Static invariants of the documents service (issue #46). Kept in its own file
 * so the main deployment suite stays under the 400-line ceiling. These tests
 * read the compose file and the Dockerfile as text: they pin the security shape
 * that a later edit could silently remove (a published port, a secret in the
 * image, a second Markdown extractor in the LibreOffice container).
 */

const ROOT = resolve(import.meta.dirname, "..", "..", "..")
const COMPOSE = readFileSync(join(ROOT, "compose.yaml"), "utf8")
const IMAGE = readFileSync(join(ROOT, "deploy/Dockerfile.documents"), "utf8")

function serviceBlocks(source: string): Map<string, string> {
  const blocks = new Map<string, string[]>()
  let inServices = false
  let current: string | undefined

  for (const line of source.split("\n")) {
    if (/^[A-Za-z]/.test(line)) {
      inServices = line.startsWith("services:")
      current = undefined
      continue
    }
    if (!inServices) continue
    const header = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line)
    const name = header?.[1]
    if (name !== undefined) {
      current = name
      blocks.set(name, [])
      continue
    }
    if (current !== undefined) blocks.get(current)?.push(line)
  }

  return new Map([...blocks].map(([name, lines]) => [name, lines.join("\n")]))
}

const SERVICES = [...serviceBlocks(COMPOSE)]
const block = serviceBlocks(COMPOSE).get("documents")
if (block === undefined) throw new Error("compose.yaml has no documents service")

describe("documents service boundaries", () => {
  it("is a local, unpublished glibc service on the backend network only", () => {
    expect(block).not.toMatch(/^ {4}ports:/m)
    expect(block).toMatch(/^ {4}expose:\n {6}- "8099"$/m)
    expect(block).toMatch(/^\s*- backend$/m)
    expect(block).not.toMatch(/^\s*- edge$/m)
    expect(block).not.toMatch(/^\s*- artifacts$/m)
    expect(block).toContain("dockerfile: deploy/Dockerfile.documents")
    expect(block).toContain("image: openchat-documents:${OPENCHAT_TAG:-local}")
  })

  it("takes its token from .env and never bakes one", () => {
    expect(block).toContain("DOCUMENTS_TOKEN: ${DOCUMENTS_TOKEN:?")
    expect(block).toContain("DOCUMENTS_PORT: \"8099\"")
    const holders = SERVICES.filter(([, body]) => body.includes("DOCUMENTS_TOKEN")).map(([name]) => name)
    expect(holders).toEqual(["documents"])
  })

  it("runs read-only with a writable temp dir and no new privileges", () => {
    expect(block).toMatch(/^ {4}read_only: true$/m)
    expect(block).toMatch(/^ {6}- \/tmp:size=256m,mode=1777$/m)
    expect(block).toMatch(/^ {4}security_opt:\n {6}- no-new-privileges:true$/m)
  })
})

describe("documents image invariants", () => {
  it("uses a digest-pinned glibc Python base, not Alpine and not Node", () => {
    expect(IMAGE).toMatch(/^ARG BASE_IMAGE=python:3\.13-slim@sha256:[0-9a-f]{64}$/m)
    expect(IMAGE).toMatch(/^FROM \$\{BASE_IMAGE\}$/m)
    expect(IMAGE).not.toMatch(/alpine|node:|NODE_IMAGE/)
  })

  it("installs headless LibreOffice and metric-compatible fonts", () => {
    expect(IMAGE).toContain("libreoffice-writer-nogui")
    expect(IMAGE).toContain("libreoffice-core-nogui")
    expect(IMAGE).toContain("fonts-crosextra-carlito")
    expect(IMAGE).toContain("fonts-crosextra-caladea")
    expect(IMAGE).toContain("apt-get install -y --no-install-recommends")
  })

  it("installs a fully pinned lock at build time and verifies the imports", () => {
    expect(IMAGE).toContain("COPY apps/documents/requirements.lock")
    expect(IMAGE).toMatch(/pip install --no-cache-dir -r \/app\/requirements\.lock/)
    expect(IMAGE).toContain("docxtpl")
    expect(IMAGE).not.toContain("markitdown")
    expect(IMAGE).not.toMatch(/pip install(?!.*requirements\.lock)/)
  })

  it("runs as a non-root user, exposes a healthcheck and copies no secret", () => {
    expect(IMAGE).toMatch(/^USER documents$/m)
    expect(IMAGE).not.toMatch(/^USER (?:root|0)$/m)
    expect(IMAGE).toMatch(/^HEALTHCHECK /m)
    expect(IMAGE).toMatch(/^ENTRYPOINT \["python", "-B", "-m", "documents\.server"\]$/m)
    expect(IMAGE).not.toMatch(/COPY .*\.env/)
    expect(IMAGE).not.toMatch(/ENV .*(?:PASSWORD|SECRET|TOKEN)=/)
  })
})
