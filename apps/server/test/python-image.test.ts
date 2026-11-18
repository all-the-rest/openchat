import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

/**
 * The Python half of the derived OpenCode image. The build itself is proven by
 * `docker build -f deploy/Dockerfile.opencode .`; these assertions keep the
 * wiring (pinned base, offline wheelhouse, apk split, network-less smoke) from
 * drifting while the build is not running.
 */

const ROOT = join(import.meta.dirname, "..", "..", "..")
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), "utf8")

const DOCKERFILE = read("deploy", "Dockerfile.opencode")

describe("Python document toolchain image", () => {
  it("resolves wheels once and installs them without a network or a compiler", () => {
    expect(DOCKERFILE).toMatch(
      /^ARG PYTHON_IMAGE=alpine:3\.24\.4@sha256:[0-9a-f]{64}$/m,
    )
    expect(DOCKERFILE).toContain("python3 -m pip download --disable-pip-version-check")
    expect(DOCKERFILE).toContain("--only-binary :all:")
    expect(DOCKERFILE).toContain("requirements.lock")
    expect(DOCKERFILE).toContain("grep -v '^#' /tmp/apk-packages.txt | xargs apk add --no-cache")
    expect(DOCKERFILE).toContain("--no-index --find-links /wheels --no-deps")
    expect(DOCKERFILE).toContain("apk del py3-pip")
    expect(DOCKERFILE).not.toMatch(/apk add[^\n]*\b(gcc|g\+\+|musl-dev|build-base)\b/)
    expect(DOCKERFILE).toContain("command -v markitdown")
  })

  it("proves markitdown works with the network disabled", () => {
    expect(DOCKERFILE).toContain("RUN --network=none python3 /opt/python-smoke.py")
    expect(DOCKERFILE).toContain("/opt/artifact-tool/packages/python-tool/python")
    const smoke = read("deploy", "python-smoke.py")
    expect(smoke).toContain('"parse_failed"')
    expect(smoke).toContain('"Traceback"')
    for (const extension of ["docx", "xlsx", "pptx", "pdf"]) {
      expect(smoke).toContain(`"${extension}"`)
    }
  })
})
