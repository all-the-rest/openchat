import type { FakeScenario, ReasoningPart, TextPart, ToolPart } from "@openchat/contracts"

const SCENARIOS: FakeScenario[] = [
  "default",
  "rich",
  "reasoning",
  "tools",
  "error",
  "abort",
  "slow",
]

export function isFakeScenario(value: string): value is FakeScenario {
  return (SCENARIOS as string[]).includes(value)
}

/**
 * A prompt prefix selects a scenario for one turn, e.g. `rich: explain this`.
 * Otherwise the constructor scenario wins.
 */
export function resolveScenario(text: string, fallback: FakeScenario): FakeScenario {
  const match = /^(rich|reasoning|tools|error|slow):/.exec(text.trimStart())
  const name = match?.[1]
  return name && isFakeScenario(name) ? name : fallback
}

function chunkText(text: string, size: number): string[] {
  const chunks: string[] = []
  for (let index = 0; index < text.length; index += size) {
    chunks.push(text.slice(index, index + size))
  }
  return chunks
}

const DEFAULT_TEXT =
  "Hello from the deterministic fake backend. This answer streams as text deltas and finishes with a completed message."

const ABORT_TEXT =
  "Working through the requested steps in the fake backend. Each chunk is short so an interrupt can land between two deltas. Nothing here calls a provider or touches the network."

const ERROR_TEXT = "The provider failed before it could answer."

const REASONING_TEXT =
  "The user wants a deterministic answer. I will outline the structure, then stream the Markdown body, and finally report a tool call."

const RICH_MARKDOWN = [
  "## Fake backend overview",
  "",
  "This sample exercises the Markdown renderer with **bold text**, _italic text_, `inline code` and inline math $e^{i\\pi}$.",
  "",
  "- Sessions live in memory",
  "- Messages stream as deltas",
  "- Tool cards update in place",
  "",
  "| Part | Purpose | Rendered |",
  "| --- | --- | --- |",
  "| text | Markdown | yes |",
  "| tool | Status card | yes |",
  "",
  "> The fake backend is a product surface, not a test hack.",
  "",
  "```ts",
  "export function greet(name: string): string {",
  "  return `hello ${name}`",
  "}",
  "```",
  "",
  "$$",
  "\\int_0^1 x^2 \\, dx = \\frac{1}{3}",
  "$$",
  "",
  "```mermaid",
  "flowchart LR",
  "  Prompt --> Backend",
  "  Backend --> Events",
  "  Events --> UI",
  "```",
].join("\n")

const TOOLS_TEXT = "Running two scripted tools: one succeeds, one fails."

const SLOW_TEXT = [
  "Slow scenario chunk one.",
  "Slow scenario chunk two.",
  "Slow scenario chunk three.",
  "Slow scenario chunk four.",
  "Slow scenario chunk five.",
  "Slow scenario chunk six.",
  "Slow scenario chunk seven.",
  "Slow scenario chunk eight.",
  "Slow scenario chunk nine.",
  "Slow scenario chunk ten.",
  "Slow scenario chunk eleven.",
  "Slow scenario chunk twelve.",
].join(" ")

export type ScenarioOutcome = "completed" | "interrupted" | "failed"

/**
 * The scripted scenarios reach the message and event state only through this
 * surface, so the fake backend keeps ownership of ids, the clock and the
 * subscriber fan-out.
 */
export interface ScenarioRuntime {
  /** Returns false when the run was interrupted, before or during the wait. */
  pause(): Promise<boolean>
  addTextPart(): TextPart
  addReasoningPart(): ReasoningPart
  addToolPart(name: string, input: string): ToolPart
  streamText(partID: string, delta: string): void
  streamReasoning(partID: string, delta: string): void
  emitTool(part: ToolPart, patch: Partial<ToolPart>): void
  addErrorPart(text: string, code: string, retryable: boolean): void
}

/** Plays one scripted scenario, one paused step at a time. */
export async function runScenario(
  runtime: ScenarioRuntime,
  scenario: FakeScenario,
): Promise<ScenarioOutcome> {
  if (scenario === "error") {
    if (!(await runtime.pause())) return "interrupted"
    runtime.addErrorPart(ERROR_TEXT, "provider_error", true)
    return "failed"
  }

  if (scenario === "rich") {
    const reasoningPart = runtime.addReasoningPart()
    for (const delta of chunkText(REASONING_TEXT, 24)) {
      if (!(await runtime.pause())) return "interrupted"
      runtime.streamReasoning(reasoningPart.id, delta)
    }

    const textPart = runtime.addTextPart()
    for (const delta of chunkText(RICH_MARKDOWN, 48)) {
      if (!(await runtime.pause())) return "interrupted"
      runtime.streamText(textPart.id, delta)
    }

    const tool = runtime.addToolPart("read", "{\"path\":\"README.md\"}")
    runtime.emitTool(tool, { status: "running" })
    if (!(await runtime.pause())) return "interrupted"
    runtime.emitTool(tool, { status: "success", output: "README contents" })
    return "completed"
  }

  if (scenario === "reasoning") {
    const reasoningPart = runtime.addReasoningPart()
    for (const delta of chunkText(REASONING_TEXT, 20)) {
      if (!(await runtime.pause())) return "interrupted"
      runtime.streamReasoning(reasoningPart.id, delta)
    }
    const textPart = runtime.addTextPart()
    for (const delta of chunkText("Reasoning finished. Here is the answer.", 16)) {
      if (!(await runtime.pause())) return "interrupted"
      runtime.streamText(textPart.id, delta)
    }
    return "completed"
  }

  if (scenario === "tools") {
    const textPart = runtime.addTextPart()
    for (const delta of chunkText(TOOLS_TEXT, 20)) {
      if (!(await runtime.pause())) return "interrupted"
      runtime.streamText(textPart.id, delta)
    }

    const working = runtime.addToolPart("bash", "{\"command\":\"pnpm test\"}")
    runtime.emitTool(working, { status: "running" })
    if (!(await runtime.pause())) return "interrupted"
    runtime.emitTool(working, { status: "success", output: "tests passed" })

    const failing = runtime.addToolPart("read", "{\"path\":\"missing.txt\"}")
    runtime.emitTool(failing, { status: "running" })
    if (!(await runtime.pause())) return "interrupted"
    runtime.emitTool(failing, {
      status: "error",
      error: "File not found: missing.txt",
    })
    return "completed"
  }

  if (scenario === "slow") {
    const textPart = runtime.addTextPart()
    for (const delta of chunkText(SLOW_TEXT, 22)) {
      if (!(await runtime.pause())) return "interrupted"
      runtime.streamText(textPart.id, delta)
    }
    return "completed"
  }

  if (scenario === "abort") {
    const textPart = runtime.addTextPart()
    for (const delta of chunkText(ABORT_TEXT, 18)) {
      if (!(await runtime.pause())) return "interrupted"
      runtime.streamText(textPart.id, delta)
    }
    return "completed"
  }

  const textPart = runtime.addTextPart()
  for (const delta of chunkText(DEFAULT_TEXT, 16)) {
    if (!(await runtime.pause())) return "interrupted"
    runtime.streamText(textPart.id, delta)
  }
  return "completed"
}
