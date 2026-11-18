/**
 * Private fake stack for the on-device dictation E2E spec: a BFF with a
 * complete (dummy) pinned model set and no STT_URL, plus its own Vite origin.
 * The worker is stubbed in the browser, so the dummy bytes are never read;
 * they exist only to make `/api/info` advertise the local path.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { STT_MODEL_FILES } from "@openchat/contracts"

export const LOCAL_STT_BFF_PORT = 8791
export const LOCAL_STT_BFF_ORIGIN = `http://127.0.0.1:${LOCAL_STT_BFF_PORT}`
export const LOCAL_STT_WEB_PORT = 5175

export const LOCAL_STT_MODEL_DIR = mkdtempSync(join(tmpdir(), "openchat-e2e-stt-"))
for (const file of STT_MODEL_FILES) {
  const path = join(LOCAL_STT_MODEL_DIR, file.path)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, "e2e-fixture")
}
