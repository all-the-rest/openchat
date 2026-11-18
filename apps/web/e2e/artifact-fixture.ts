import { createHash } from "node:crypto"

/**
 * One deterministic artifact for the E2E suite. The store is seeded before the
 * BFF and the artifact host start; neither process ever writes during a test.
 */
export const E2E_ARTIFACT_TITLE = "Interest calculator"
export const E2E_ARTIFACT_CREATED_AT = "2026-11-18T12:00:00.000Z"
export const E2E_ARTIFACT_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Interest calculator</title></head>
<body>
<main>
<h1>Interest calculator</h1>
<p data-testid="artifact-stub">Compounded monthly.</p>
</main>
</body>
</html>`

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
