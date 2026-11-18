import { EVENT } from "@openchat/contracts"
import type { FakeScenario, Message, TokenUsage } from "@openchat/contracts"
import type { PartWriter } from "./fake-parts"
import { clone, errorText } from "./fake-parts"
import { resolveScenario, runScenario } from "./scenarios"
import type { ScenarioOutcome } from "./scenarios"

interface RunState {
  sessionID: string
  messageID: string
  cancelled: boolean
  wake?: () => void
}

/** One pending turn; `messageID` is also the inbox entry id. */
export interface QueuedPrompt {
  messageID: string
  text: string
  created: number
}

export interface FakeRunnerOptions {
  emit: (
    type: string,
    sessionID: string,
    data: Record<string, unknown>,
    durable: boolean,
  ) => unknown
  nextID: () => string
  clock: () => number
  parts: PartWriter
  scenario: FakeScenario
  delayMs?: number
  /** Live message array of one session; the runner appends its assistant turn. */
  messages: (sessionID: string) => Message[]
  /** Marks the session as changed. */
  touch: (sessionID: string) => void
  /** Usage a completed turn reports; also emits the usage event. */
  usage: (sessionID: string) => TokenUsage
}

/**
 * Scripted run engine of the fake backend: one active run per session, a FIFO
 * of queued prompts, interruption and the scenario events. Split from the
 * store so the backend facade stays within the file-length budget.
 */
export class FakeRunner {
  private readonly runs = new Map<string, RunState>()
  private readonly queues = new Map<string, QueuedPrompt[]>()

  constructor(private readonly options: FakeRunnerOptions) {}

  isStreaming(sessionID: string): boolean {
    return this.runs.has(sessionID)
  }

  interrupt(sessionID: string): void {
    const run = this.runs.get(sessionID)
    if (!run) return
    run.cancelled = true
    run.wake?.()
  }

  enqueue(sessionID: string, entry: QueuedPrompt): void {
    const queue = this.queues.get(sessionID) ?? []
    queue.push(entry)
    this.queues.set(sessionID, queue)
  }

  queued(sessionID: string): QueuedPrompt[] {
    return this.queues.get(sessionID) ?? []
  }

  /** Removes one queued turn; false when the id is not pending. */
  cancelQueued(sessionID: string, messageID: string): boolean {
    const queue = this.queues.get(sessionID) ?? []
    const index = queue.findIndex((entry) => entry.messageID === messageID)
    if (index === -1) return false
    queue.splice(index, 1)
    if (queue.length === 0) this.queues.delete(sessionID)
    return true
  }

  /** Creates the assistant turn, appends it and starts the scripted run. */
  start(sessionID: string, text: string): Message {
    const message: Message = {
      id: this.options.nextID(),
      sessionID,
      role: "assistant",
      parts: [],
      created: this.options.clock(),
      status: "streaming",
    }
    this.options.messages(sessionID).push(message)
    this.startRun(sessionID, message.id, text)
    return message
  }

  private startRun(sessionID: string, messageID: string, text: string): void {
    const scenario = resolveScenario(text, this.options.scenario)
    const delay = this.options.delayMs ?? (scenario === "slow" ? 400 : 15)
    const run: RunState = { sessionID, messageID, cancelled: false }
    this.runs.set(sessionID, run)
    void this.run(run, scenario, delay).catch(() => {
      // The run already reports failures through events.
      this.runs.delete(sessionID)
      this.startNext(sessionID)
    })
  }

  /** Promotes the next queued prompt, if any, after a run ended. */
  private startNext(sessionID: string): void {
    const queue = this.queues.get(sessionID)
    const next = queue?.shift()
    if (!queue || !next) {
      this.queues.delete(sessionID)
      return
    }
    if (queue.length === 0) this.queues.delete(sessionID)
    this.start(sessionID, next.text)
  }

  private findMessage(sessionID: string, messageID: string): Message {
    const message = this.options.messages(sessionID).find((entry) => entry.id === messageID)
    if (!message) throw new Error(`Unknown fake message: ${messageID}`)
    return message
  }

  /** One scripted step; false means interrupted before or during the wait. */
  private pause(run: RunState, delayMs: number): Promise<boolean> {
    if (run.cancelled) return Promise.resolve(false)
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const done = () => {
        if (timer !== undefined) clearTimeout(timer)
        run.wake = undefined
        resolve(!run.cancelled)
      }
      run.wake = done
      timer = setTimeout(done, delayMs)
    })
  }

  private async run(run: RunState, scenario: FakeScenario, delayMs: number): Promise<void> {
    const message = this.findMessage(run.sessionID, run.messageID)
    let outcome: ScenarioOutcome = "completed"

    this.options.emit(
      EVENT.executionStarted,
      run.sessionID,
      { sessionID: run.sessionID, messageID: message.id },
      true,
    )

    try {
      outcome = await this.performScenario(run, message, scenario, delayMs)
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Unknown fake backend error"
      this.options.parts.addError(run.sessionID, message, reason, "fake_error", false)
      outcome = "failed"
    }

    if (outcome === "completed") {
      message.usage = this.options.usage(run.sessionID)
      message.status = "complete"
      this.completeMessage(run, message)
      this.options.emit(
        EVENT.executionSucceeded,
        run.sessionID,
        { sessionID: run.sessionID, messageID: message.id },
        true,
      )
    } else if (outcome === "interrupted") {
      message.status = "stopped"
      this.options.emit(
        EVENT.interrupted,
        run.sessionID,
        { sessionID: run.sessionID, messageID: message.id },
        true,
      )
      this.completeMessage(run, message)
    } else {
      message.status = "error"
      this.completeMessage(run, message)
      this.options.emit(
        EVENT.executionFailed,
        run.sessionID,
        {
          sessionID: run.sessionID,
          messageID: message.id,
          message: errorText(message) ?? "The fake backend failed",
          code: "fake_error",
          retryable: false,
        },
        true,
      )
    }

    this.runs.delete(run.sessionID)
    this.startNext(run.sessionID)
  }

  private performScenario(
    run: RunState,
    message: Message,
    scenario: FakeScenario,
    delayMs: number,
  ): Promise<ScenarioOutcome> {
    const sid = run.sessionID
    return runScenario(
      {
        pause: () => this.pause(run, delayMs),
        addTextPart: () => this.options.parts.addText(message),
        addReasoningPart: () => this.options.parts.addReasoning(message),
        addToolPart: (name, input) => this.options.parts.addTool(message, name, input),
        streamText: (partID, delta) =>
          this.options.parts.streamText(sid, message, partID, delta),
        streamReasoning: (partID, delta) =>
          this.options.parts.streamReasoning(sid, message, partID, delta),
        emitTool: (part, patch) => this.options.parts.emitTool(sid, message, part, patch),
        addErrorPart: (text, code, retryable) =>
          this.options.parts.addError(sid, message, text, code, retryable),
      },
      scenario,
    )
  }

  private completeMessage(run: RunState, message: Message): void {
    this.options.touch(run.sessionID)
    this.options.emit(
      EVENT.messageCompleted,
      run.sessionID,
      { sessionID: run.sessionID, messageID: message.id, message: clone(message) },
      true,
    )
  }
}
