import type { FormAnswer, FormField, FormRequest, SessionInfo } from "@openchat/contracts"
import { EVENT } from "@openchat/contracts"
import type { CreateSessionInput } from "./index"
import type { FakeCompaction } from "./fake-compaction"
import type { FakeEvents } from "./fake-events"
import type { FakeForms } from "./fake-forms"
import { clone } from "./fake-parts"
import type { FakeSessionStore } from "./fake-sessions"
import type { SessionState } from "./fake-state"
import { FakeTaskStore } from "./fake-tasks"

/**
 * Session lifecycle and interactive forms of the fake backend. Split from the
 * facade so `fake.ts` stays within the file-length budget; everything here
 * works against the injected store, the event fan-out and the form store.
 */
export abstract class FakeSessionLifecycle extends FakeTaskStore {
  protected abstract readonly store: FakeSessionStore
  protected abstract readonly events: FakeEvents
  protected abstract readonly clock: () => number
  protected abstract readonly forms: FakeForms
  protected abstract readonly compaction: FakeCompaction

  async listSessions(): Promise<SessionInfo[]> {
    return this.store.list()
      .map((session) => {
        const info = clone(session.info)
        const usage = this.compaction.usageOf(session.info.id)
        if (usage) info.usage = usage
        return info
      })
      .sort((left, right) => left.created - right.created)
  }

  async createSession(input: CreateSessionInput): Promise<SessionInfo> {
    const created = this.clock()
    // An empty title lets the UI render its own localized placeholder.
    const info: SessionInfo = {
      id: this.events.nextID("ses"), title: input.title?.trim() ?? "",
      directory: input.directory, created, updated: created,
    }
    this.store.create(info, input.model, input.agent)
    this.events.emit(EVENT.sessionCreated, info.id, {
      sessionID: info.id, title: info.title, directory: info.directory,
    }, true)
    return clone(info)
  }

  async putInstruction(sessionID: string, key: string, value: string): Promise<void> {
    const session = this.requireSession(sessionID)
    session.instructions ??= new Map()
    session.instructions.set(key, value)
  }

  async renameSession(sessionID: string, title: string): Promise<SessionInfo> {
    return this.store.rename(sessionID, title, this.clock())
  }

  async listForms(sessionID: string): Promise<FormRequest[]> {
    this.requireSession(sessionID)
    return this.forms.list(sessionID)
  }

  async replyForm(sessionID: string, formID: string, answer: FormAnswer): Promise<void> {
    this.requireSession(sessionID)
    this.forms.reply(sessionID, formID, answer)
  }

  /** Fake-mode control: opens one form a browser has to answer. */
  seedForm(sessionID: string, fields?: FormField[]): FormRequest {
    this.requireSession(sessionID)
    return this.forms.seed(sessionID, fields)
  }

  /** Fake-mode probe: the stored value of one instruction entry. */
  getInstruction(sessionID: string, key: string): string | undefined {
    return this.requireSession(sessionID).instructions?.get(key)
  }

  protected override requireSession(sessionID: string): SessionState {
    return this.store.require(sessionID)
  }
}
