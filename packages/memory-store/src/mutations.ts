/**
 * Mutation half of the store. Every method takes the cross-process lock, reads
 * the source of truth, applies the whole batch, persists once, appends audit
 * rows and regenerates the index. Reads never take the lock.
 */
import { randomBytes } from "node:crypto"
import { planPrune } from "./prune"
import { checksumOf, MemoryStoreBase, ttl } from "./store"
import { isDuplicate, validateDraft, validateUpdate } from "./validate"
import { MAX_FACTS, MAX_TOTAL_BYTES } from "./limits"
import type {
  DeleteOutcome,
  MemoryAuditEntry,
  MemoryFact,
  PruneOptions,
  PruneResult,
  UpdateOutcome,
  WriteOutcome,
} from "./types"

/** Full store: read methods come from `MemoryStoreBase`, writes from here. */
export class MemoryStore extends MemoryStoreBase {
  /** Validates and writes a batch; near-identical active facts are deduped. */
  async write(values: readonly unknown[], actor: string): Promise<WriteOutcome[]> {
    return this.withLock(async () => {
      const facts = await this.readFacts()
      let bytes = Buffer.byteLength(facts.map((fact) => JSON.stringify(fact)).join("\n"))
      const outcomes: WriteOutcome[] = []
      const rows: MemoryAuditEntry[] = []
      let changed = false

      for (const value of values) {
        const checked = validateDraft(value)
        if (!checked.ok || !checked.draft) {
          outcomes.push({
            ok: false,
            code: checked.ok ? "invalid" : checked.code,
            message: checked.ok ? "invalid: entry was rejected" : checked.message,
          })
          continue
        }
        const draft = checked.draft
        const twin = facts.find(
          (fact) => fact.status === "active" && isDuplicate(draft.text, fact.text),
        )
        if (twin) {
          outcomes.push({
            ok: false,
            code: "duplicate",
            duplicateOf: twin.id,
            message: "duplicate: a near-identical active fact already exists",
          })
          continue
        }
        if (facts.length >= MAX_FACTS) {
          outcomes.push({ ok: false, code: "capacity", message: "capacity: too many facts; prune first" })
          continue
        }
        const now = this.now()
        const id = draft.id ?? `f_${randomBytes(6).toString("hex")}`
        if (facts.some((fact) => fact.id === id)) {
          outcomes.push({ ok: false, code: "invalid", message: "invalid: id already exists" })
          continue
        }
        const createdAt = draft.createdAt ?? new Date(now).toISOString()
        const supersedes = facts
          .filter(
            (fact) => fact.status === "active" && fact.topic.toLowerCase() === draft.topic.toLowerCase(),
          )
          .map((fact) => fact.id)
        const base: Omit<MemoryFact, "checksum"> = {
          id,
          text: draft.text,
          topic: draft.topic,
          tags: draft.tags,
          source: draft.source ?? { sessionID: "", messageID: "", at: createdAt },
          trust: draft.trust,
          status: "active",
          supersedes,
          createdAt,
          lastConfirmedAt: createdAt,
          expiresAt: draft.expiresAt ?? new Date(ttl(draft.trust, now)).toISOString(),
        }
        const fact: MemoryFact = { ...base, checksum: checksumOf({ ...base, checksum: "" }) }
        const rowBytes = Buffer.byteLength(JSON.stringify(fact), "utf8") + 1
        if (bytes + rowBytes > MAX_TOTAL_BYTES) {
          outcomes.push({ ok: false, code: "capacity", message: "capacity: store byte cap reached" })
          continue
        }
        for (const oldId of supersedes) {
          const old = facts.find((entry) => entry.id === oldId)
          if (old) old.status = "superseded"
          rows.push(this.audit("supersede", [oldId], `superseded by ${id}`, actor))
        }
        bytes += rowBytes
        facts.push(fact)
        rows.push(this.audit("write", [id], "agent write", actor))
        outcomes.push({ ok: true, id })
        changed = true
      }

      if (changed) {
        await this.refresh(facts)
        await this.appendAudit(rows)
      }
      return outcomes
    })
  }

  /** Applies field changes and explicit confirmations to chosen facts. */
  async update(values: readonly unknown[], actor: string): Promise<UpdateOutcome[]> {
    return this.withLock(async () => {
      const facts = await this.readFacts()
      const byId = new Map(facts.map((fact) => [fact.id, fact]))
      const outcomes: UpdateOutcome[] = []
      const rows: MemoryAuditEntry[] = []
      let changed = false

      for (const value of values) {
        const checked = validateUpdate(value)
        if (!checked.ok || !checked.update) {
          outcomes.push({
            ok: false,
            code: checked.ok ? "invalid" : checked.code,
            message: checked.ok ? "invalid: update was rejected" : checked.message,
          })
          continue
        }
        const spec = checked.update
        const fact = byId.get(spec.id)
        if (!fact) {
          outcomes.push({ ok: false, code: "unknown", message: "unknown: no such fact" })
          continue
        }
        if (spec.text !== undefined) fact.text = spec.text
        if (spec.topic !== undefined) fact.topic = spec.topic
        if (spec.tags !== undefined) fact.tags = spec.tags
        if (spec.trust !== undefined) fact.trust = spec.trust
        if (spec.status !== undefined) fact.status = spec.status
        if (spec.expiresAt !== undefined) fact.expiresAt = spec.expiresAt
        if (spec.confirm) {
          fact.lastConfirmedAt = new Date(this.now()).toISOString()
          fact.expiresAt = new Date(ttl(fact.trust, this.now())).toISOString()
        }
        fact.checksum = checksumOf({ ...fact, checksum: "" })
        rows.push(this.audit("update", [fact.id], spec.reason ?? "agent update", actor))
        outcomes.push({ ok: true, id: fact.id, status: fact.status })
        changed = true
      }

      if (changed) {
        await this.refresh(facts)
        await this.appendAudit(rows)
      }
      return outcomes
    })
  }

  /** Soft delete; unknown ids are a no-op so an oversized store can always shrink. */
  async delete(ids: readonly string[], reason: string, actor: string): Promise<DeleteOutcome[]> {
    return this.withLock(async () => {
      const facts = await this.readFacts()
      const rows: MemoryAuditEntry[] = []
      let changed = false
      for (const id of ids) {
        const fact = facts.find((entry) => entry.id === id)
        if (fact) {
          fact.status = "deleted"
          fact.checksum = checksumOf({ ...fact, checksum: "" })
          changed = true
        }
        rows.push(this.audit("delete", [id], reason, actor))
      }
      if (changed) {
        await this.refresh(facts)
        await this.appendAudit(rows)
      }
      return ids.map((id) => ({ ok: true as const, id }))
    })
  }

  /** Dry run returns the plan; apply physically removes rows and audits them. */
  async prune(options: PruneOptions, actor: string): Promise<PruneResult> {
    return this.withLock(async () => {
      const facts = await this.readFacts()
      const candidates = planPrune(facts, options, this.now())
      if (options.dryRun !== false) return { dryRun: true, candidates, applied: [] }
      const doomed = new Set(candidates.map((candidate) => candidate.id))
      const remaining = facts.filter((fact) => !doomed.has(fact.id))
      const rows = candidates.map((candidate) =>
        this.audit("prune", [candidate.id], `${candidate.reason}: ${candidate.text.slice(0, 120)}`, actor),
      )
      await this.refresh(remaining)
      await this.appendAudit(rows)
      return { dryRun: false, candidates, applied: [...doomed] }
    })
  }
}
