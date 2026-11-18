import type {
  BackgroundJob,
  FakeScenario,
  Message,
  SearchSource,
  SessionInfo,
} from "@openchat/contracts"

/** State of one active fake run; `wake` ends an interruptible pause. */
export interface RunState {
  sessionID: string
  messageID: string
  cancelled: boolean
  wake?: () => void
}

export interface SessionState {
  info: SessionInfo
  messages: Message[]
}

export interface QueuedPrompt {
  /** Id of the queued user message; this is the inbox entry id. */
  messageID: string
  text: string
  created: number
}

/** Last accepted prompt of a session, exposed through the fake-mode probe. */
export interface RecordedPrompt {
  text: string
  model?: string
  variant?: string
  agent?: string
}

export interface FakeBackendOptions {
  /** Scenario for prompts without a prefix. Defaults to `default`. */
  scenario?: FakeScenario
  /**
   * Delay between scripted chunks in milliseconds. Defaults to 15, or 400 for
   * the `slow` scenario. Tests pass 0.
   */
  delayMs?: number
  /** Injected clock for deterministic ids/timestamps. */
  now?: () => number
  workspace?: string
  version?: string
  /** Sources the fake reports as unavailable, for the disabled group state. */
  disabledSources?: readonly SearchSource[]
  /** Sources whose query throws, for a partial failure in the response. */
  failingSources?: readonly SearchSource[]
  /** False simulates a host without an app surface: `listApps` throws. */
  appsAvailable?: boolean
  /** Records connect/disconnect calls, so a test can prove the port is used. */
  onAppAction?: (action: "connect" | "disconnect", name: string) => void
  /** Deterministic background jobs for the `/tasks` page. Empty by default. */
  seedJobs?: readonly BackgroundJob[]
  /** Seeds one parent and one child chat, linked by `parentID`. */
  seedSubagents?: boolean
}
