import { createHash } from "node:crypto"
import { buildDocument } from "../../../packages/artifact-tool/src/shell"

/**
 * One deterministic artifact for the E2E suite. The store is seeded before the
 * BFF and the artifact host start; neither process ever writes during a test.
 */
export const E2E_ARTIFACT_TITLE = "Interest calculator"
export const E2E_ARTIFACT_CREATED_AT = "2026-11-18T12:00:00.000Z"

/**
 * A hand-written classic script stands in for a compiled bundle, but the
 * document around it is the real shell (`buildDocument`): the bridge shim is
 * inlined, so the `artifact:init` → `artifact:ready` handshake happens and the
 * viewer's in-place reset path is reachable. The shim's `artifact:resize`
 * gives the test a deterministic signal that a ready frame answered.
 */
const E2E_ARTIFACT_SCRIPT = `(function () {
  var root = document.getElementById("root")
  if (!root) return
  var heading = document.createElement("h1")
  heading.textContent = "Interest calculator"
  var note = document.createElement("p")
  note.setAttribute("data-testid", "artifact-stub")
  note.textContent = "Compounded monthly."
  root.appendChild(heading)
  root.appendChild(note)
})()`

export const E2E_ARTIFACT_HTML = buildDocument({
  title: E2E_ARTIFACT_TITLE,
  css: "",
  script: E2E_ARTIFACT_SCRIPT,
  // The drift comment is filler: no compiler produced this stub.
  tools: { esbuild: "e2e fixture", preact: "e2e fixture" },
})

/** Content-addressed, exactly like the store. */
export const E2E_ARTIFACT_ID = createHash("sha256")
  .update(E2E_ARTIFACT_HTML)
  .digest("hex")

/** One valid 1×1 PNG, stored as media bytes and signed like any artifact. */
export const E2E_IMAGE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
)
export const E2E_IMAGE_TITLE = "Pixel swatch"
export const E2E_IMAGE_CREATED_AT = "2026-11-18T12:01:00.000Z"
export const E2E_IMAGE_ID = createHash("sha256").update(E2E_IMAGE_PNG).digest("hex")

/** A minimal PDF; the viewer frames it on the artifact origin, never inline. */
export const E2E_PDF = Buffer.from(
  "%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n",
)
export const E2E_PDF_TITLE = "One page report"
export const E2E_PDF_CREATED_AT = "2026-11-18T12:02:00.000Z"
export const E2E_PDF_ID = createHash("sha256").update(E2E_PDF).digest("hex")

/** Fixed loopback origin for the real artifact host. */
export const E2E_ARTIFACT_HOST_URL = "http://127.0.0.1:4100"
/** Shared with the BFF through the Playwright config env. */
export const E2E_ARTIFACT_SIGNING_KEY = "openchat-e2e-artifact-signing-key-0123456789"
/** The chat origin allowed to frame a document. */
export const E2E_ARTIFACT_FRAME_ANCESTORS = "http://localhost:5173"
