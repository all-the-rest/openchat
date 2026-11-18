import type { BackgroundJob, EventEnvelope, PermissionDecision, Schedule } from "@openchat/contracts"
import { BackendError } from "./errors"
import type {
  AppsSnapshot,
  ChatBackend,
  CreateScheduleInput,
  CreateSessionInput,
  PromptInput,
  PromptResult,
  SearchInput,
  SearchOutcome,
} from "./index"

/**
 * Test-only decorator for `FakeBackend`: while `down`, every host call rejects
 * like a refused upstream and the event stream ends, exactly as it does when
 * the service behind `OPENCODE_URL` goes away. The E2E control route flips it
 * so the browser can watch an outage and a reconnect without stopping the BFF.
 *
 * This is not a tunnel feature: it simulates the one backend state the live
 * adapter already produces, and it exists only in `BACKEND_MODE=fake`.
 */
export class FakeHostSwitch implements ChatBackend {
  private hostDown = false
  private stop = new AbortController()

  constructor(private readonly backend: ChatBackend) {}

  get down(): boolean {
    return this.hostDown
  }

  /** The wrapped backend, so the fake-mode probe can reach its test hooks. */
  get inner(): ChatBackend {
    return this.backend
  }

  setHostDown(down: boolean): void {
    if (down === this.hostDown) return
    this.hostDown = down
    if (!down) return
    // A real upstream drop ends every open stream; aborting the inner iterator
    // makes the fake do the same, so EventSource sees an error and reconnects.
    this.stop.abort()
    this.stop = new AbortController()
  }

  private guard(): void {
    if (this.hostDown) {
      throw new BackendError("unavailable", "The OpenCode host is not reachable")
    }
  }

  async info(): ReturnType<ChatBackend["info"]> {
    this.guard()
    return this.backend.info()
  }

  async listSessions(): ReturnType<ChatBackend["listSessions"]> {
    this.guard()
    return this.backend.listSessions()
  }

  async createSession(input: CreateSessionInput): ReturnType<ChatBackend["createSession"]> {
    this.guard()
    return this.backend.createSession(input)
  }

  async listMessages(sessionID: string): ReturnType<ChatBackend["listMessages"]> {
    this.guard()
    return this.backend.listMessages(sessionID)
  }

  async prompt(sessionID: string, input: PromptInput): Promise<PromptResult> {
    this.guard()
    return this.backend.prompt(sessionID, input)
  }

  async listInbox(sessionID: string): ReturnType<ChatBackend["listInbox"]> {
    this.guard()
    return this.backend.listInbox(sessionID)
  }

  async cancelQueued(sessionID: string, messageID: string): Promise<void> {
    this.guard()
    return this.backend.cancelQueued(sessionID, messageID)
  }

  async interrupt(sessionID: string): Promise<void> {
    this.guard()
    return this.backend.interrupt(sessionID)
  }

  async listModels(): ReturnType<ChatBackend["listModels"]> {
    this.guard()
    return this.backend.listModels()
  }

  async listAgents(): ReturnType<ChatBackend["listAgents"]> {
    this.guard()
    return this.backend.listAgents()
  }

  async listPermissions(sessionID: string) {
    this.guard()
    return this.backend.listPermissions(sessionID)
  }

  async replyPermission(
    sessionID: string,
    requestID: string,
    decision: PermissionDecision,
  ): Promise<void> {
    this.guard()
    return this.backend.replyPermission(sessionID, requestID, decision)
  }

  async listApps(): Promise<AppsSnapshot> {
    this.guard()
    return this.backend.listApps()
  }

  async connectApp(name: string): Promise<void> {
    this.guard()
    return this.backend.connectApp(name)
  }

  async disconnectApp(name: string): Promise<void> {
    this.guard()
    return this.backend.disconnectApp(name)
  }

  async search(input: SearchInput): Promise<SearchOutcome> {
    this.guard()
    return this.backend.search(input)
  }

  async listSchedules(sessionID: string): Promise<Schedule[]> {
    this.guard()
    return this.backend.listSchedules(sessionID)
  }

  async createSchedule(input: CreateScheduleInput): Promise<Schedule> {
    this.guard()
    return this.backend.createSchedule(input)
  }

  async pauseSchedule(id: string): Promise<Schedule> {
    this.guard()
    return this.backend.pauseSchedule(id)
  }

  async resumeSchedule(id: string): Promise<Schedule> {
    this.guard()
    return this.backend.resumeSchedule(id)
  }

  async deleteSchedule(id: string): Promise<void> {
    this.guard()
    return this.backend.deleteSchedule(id)
  }

  async listJobs(): Promise<BackgroundJob[]> {
    this.guard()
    return this.backend.listJobs()
  }

  async *subscribe(signal?: AbortSignal): AsyncIterable<EventEnvelope> {
    if (this.hostDown || signal?.aborted) return

    // The BFF's route signal and the switch's own outage signal both tear the
    // inner subscription down. Without the inner abort, the fake would keep a
    // subscriber that no longer has a response to write to.
    const local = new AbortController()
    const stop = () => local.abort()
    this.stop.signal.addEventListener("abort", stop, { once: true })
    signal?.addEventListener("abort", stop, { once: true })

    try {
      for await (const event of this.backend.subscribe(local.signal)) {
        if (this.hostDown) return
        yield event
      }
    } finally {
      this.stop.signal.removeEventListener("abort", stop)
      signal?.removeEventListener("abort", stop)
      local.abort()
    }
  }
}
