import { api } from "../api/client"
import type { LocalDictation } from "./useLocalDictation"

/** One transcription attempt, on-device first and the server as the fallback. */
export type TranscribeOutcome =
  | { ok: true; path: "local" | "server"; text: string }
  | { ok: false; path: "local" | "server"; error: unknown }

/**
 * Runs the chosen path and, when the local model fails while a server is
 * configured, retries the same bytes there once. A broken model must never
 * leave a silent microphone; the path in the outcome selects the error map.
 */
export async function transcribeAudio(
  blob: Blob,
  language: string,
  local: Pick<LocalDictation, "path" | "serverAvailable" | "run" | "switchToServer">,
): Promise<TranscribeOutcome> {
  if (local.path === "local") {
    try {
      const { text } = await local.run(blob, language)
      return { ok: true, path: "local", text: text.trim() }
    } catch (error) {
      if (!local.serverAvailable) return { ok: false, path: "local", error }
      local.switchToServer()
    }
  }

  try {
    const result = await api.transcribe(blob, { language })
    return {
      ok: true,
      path: "server",
      text: typeof result?.text === "string" ? result.text.trim() : "",
    }
  } catch (error) {
    return { ok: false, path: "server", error }
  }
}
