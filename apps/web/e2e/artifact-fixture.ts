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

/** Fixed loopback origin for the real artifact host. */
export const E2E_ARTIFACT_HOST_URL = "http://127.0.0.1:4100"
/** Shared with the BFF through the Playwright config env. */
export const E2E_ARTIFACT_SIGNING_KEY = "openchat-e2e-artifact-signing-key-0123456789"
/** The chat origin allowed to frame a document. */
export const E2E_ARTIFACT_FRAME_ANCESTORS = "http://localhost:5173"
