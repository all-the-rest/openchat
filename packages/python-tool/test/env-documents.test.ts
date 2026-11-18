import { describe, expect, it } from "vitest"
import { loadDocumentsToolEnv } from "../src/env"

const BASE = {
  ARTIFACT_INTERNAL_TOKEN: "artifact-token-0123456789abcdef",
  DOCUMENTS_TOKEN: "documents-token-0123456789abcdef",
}

describe("documents tool environment", () => {
  it("defaults the workspace and documents service to the compose names", () => {
    const env = loadDocumentsToolEnv({ source: BASE })
    expect(env.workspaceDir).toBe("/workspace")
    expect(env.documentsUrl).toBe("http://documents:8099")
    expect(env.documentsToken).toBe(BASE.DOCUMENTS_TOKEN)
    expect(env.python).toBe("python3")
  })

  it("accepts explicit values and strips a trailing slash", () => {
    const env = loadDocumentsToolEnv({
      source: {
        ...BASE,
        WORKSPACE_DIR: "/srv/workspace///",
        DOCUMENTS_URL: "http://127.0.0.1:8099/api/",
      },
    })
    expect(env.workspaceDir).toBe("/srv/workspace")
    expect(env.documentsUrl).toBe("http://127.0.0.1:8099/api")
  })

  it("refuses a missing token, a relative workspace and an unsafe URL", () => {
    expect(() => loadDocumentsToolEnv({ source: { ARTIFACT_INTERNAL_TOKEN: BASE.ARTIFACT_INTERNAL_TOKEN } })).toThrow("DOCUMENTS_TOKEN")
    expect(() => loadDocumentsToolEnv({ source: { ...BASE, WORKSPACE_DIR: "relative" } })).toThrow("WORKSPACE_DIR")
    expect(() => loadDocumentsToolEnv({ source: { ...BASE, DOCUMENTS_URL: "file:///etc/passwd" } })).toThrow("http or https")
  })
})
