/**
 * Message rendering and tool cards.
 *
 * Explicit ids keep the public `t("key")` API stable; the German text lives in
 * `src/locales/de/messages.po`.
 */
import { msg } from "@lingui/core/macro"

export const render = {
  "render.reasoning": msg({ id: "render.reasoning", message: "Reasoning" }),
  "render.reasoningStreaming": msg({ id: "render.reasoningStreaming", message: "Reasoning in progress" }),
  "render.toolInput": msg({ id: "render.toolInput", message: "Input" }),
  "render.toolOutput": msg({ id: "render.toolOutput", message: "Output" }),
  "render.showFull": msg({ id: "render.showFull", message: "Show full" }),
  "render.showLess": msg({ id: "render.showLess", message: "Show less" }),
  "render.error": msg({ id: "render.error", message: "Error" }),
  "render.errorUnknown": msg({ id: "render.errorUnknown", message: "The request failed." }),
  "render.errorCode": msg({ id: "render.errorCode", message: "Code: {code}" }),
  "render.retryable": msg({ id: "render.retryable", message: "This error can be retried." }),
  "render.unknownPart": msg({ id: "render.unknownPart", message: "Unsupported content: {type}" }),
  "render.code": msg({ id: "render.code", message: "Code" }),
  "render.copyCode": msg({ id: "render.copyCode", message: "Copy code" }),
  "render.wrap": msg({ id: "render.wrap", message: "Toggle line wrapping" }),
  "render.copied": msg({ id: "render.copied", message: "Copied" }),
  "render.mermaidLoading": msg({ id: "render.mermaidLoading", message: "Rendering diagram…" }),

  "tool.status.queued": msg({ id: "tool.status.queued", message: "Queued" }),
  "tool.status.running": msg({ id: "tool.status.running", message: "Running" }),
  "tool.status.success": msg({ id: "tool.status.success", message: "Done" }),
  "tool.status.error": msg({ id: "tool.status.error", message: "Error" }),
} as const
