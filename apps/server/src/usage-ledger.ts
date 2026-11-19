/**
 * Per-day spend ledger. One JSONL file per local day under an injected
 * directory; rows are appended under a small in-process lock and reads skip a
 * corrupt line instead of failing. The file is capped, and a further row is
 * refused with a stable code rather than rotated away: the day's history is
 * more useful than a silent reset.
 */
import { constants } from "node:fs"
import { chmod, lstat, mkdir, open } from "node:fs/promises"
import { join } from "node:path"

/** Default cap for one day's file. A few thousand turns fit comfortably. */
export const USAGE_LEDGER_MAX_BYTES = 4 * 1024 * 1024

export type UsageLedgerErrorCode = "usage_ledger_full" | "usage_ledger_invalid"

/** A ledger failure a caller can branch on without parsing the message. */
export class UsageLedgerError extends Error {
  readonly code: UsageLedgerErrorCode

  constructor(code: UsageLedgerErrorCode, message: string) {
    super(message)
    this.name = "UsageLedgerError"
    this.code = code
  }
}

export interface UsageLedgerOptions {
  /** Directory holding the day files; created on first write. */
  directory: string
  /** Injected clock; also defines the local day boundary. */
  now?: () => number
  /** Cap of one day file in bytes. Defaults to `USAGE_LEDGER_MAX_BYTES`. */
  maxFileBytes?: number
}

/** One turn to record. `at` is taken from the injected clock. */
export interface UsageEntry {
  providerID: string
  modelID: string
  turns: number
  costMicros: number
  /** True only when the answered model is explicitly free. */
  isFree?: boolean
}

/** One appended row. */
export interface UsageRow {
  at: number
  providerID: string
  modelID: string
  turns: number
  costMicros: number
  /** Absent on rows written before the paid-turn cap existed: counted as paid. */
  isFree?: boolean
}

export interface UsageScan {
  turns: number
  /** Turns whose answered model was not explicitly free. */
  paidTurns: number
  costMicros: number
  /** Lines that did not parse; skipped, never fatal. */
  skipped: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200
}

/** `YYYY-MM-DD` in the process's local time zone. */
export function localDay(at: number): string {
  const date = new Date(at)
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${date.getFullYear()}-${month}-${day}`
}

/** A stored row must match the shape this module writes. */
function parseRow(line: string): UsageRow | null {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return null
  }
  if (!isRecord(value)) return null
  const { at, providerID, modelID, turns, costMicros, isFree } = value
  if (typeof at !== "number" || !Number.isFinite(at) || at < 0) return null
  if (!isText(providerID) || !isText(modelID)) return null
  if (!isCount(turns) || !isCount(costMicros)) return null
  if (isFree !== undefined && typeof isFree !== "boolean") return null
  return {
    at,
    providerID,
    modelID,
    turns,
    costMicros,
    ...(isFree === undefined ? {} : { isFree }),
  }
}

export class UsageLedger {
  private readonly directory: string
  private readonly now: () => number
  private readonly maxFileBytes: number
  private tail: Promise<unknown> = Promise.resolve()

  constructor(options: UsageLedgerOptions) {
    const maxFileBytes = options.maxFileBytes ?? USAGE_LEDGER_MAX_BYTES
    if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1) {
      throw new Error("UsageLedger needs a positive byte cap")
    }
    this.directory = options.directory
    this.now = options.now ?? (() => Date.now())
    this.maxFileBytes = maxFileBytes
  }

  /** Serialises writes and reads so a scan never sees a half-appended row. */
  private run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.then(task, task)
    this.tail = next.catch(() => undefined)
    return next
  }

  /** Appends one row for today; throws `usage_ledger_full` past the cap. */
  async record(entry: UsageEntry): Promise<void> {
    if (!isText(entry.providerID) || !isText(entry.modelID)) {
      throw new UsageLedgerError("usage_ledger_invalid", "Ledger entry needs a provider and a model")
    }
    if (!isCount(entry.turns) || !isCount(entry.costMicros)) {
      throw new UsageLedgerError(
        "usage_ledger_invalid",
        "Ledger entry needs non-negative integer turns and costMicros",
      )
    }
    if (entry.isFree !== undefined && typeof entry.isFree !== "boolean") {
      throw new UsageLedgerError("usage_ledger_invalid", "Ledger entry isFree must be a boolean")
    }

    await this.run(async () => {
      const at = this.now()
      if (!Number.isFinite(at) || at < 0) {
        throw new UsageLedgerError("usage_ledger_invalid", "Ledger clock returned an invalid time")
      }
      const row: UsageRow = {
        at,
        providerID: entry.providerID,
        modelID: entry.modelID,
        turns: entry.turns,
        costMicros: entry.costMicros,
        ...(entry.isFree === undefined ? {} : { isFree: entry.isFree }),
      }
      const line = `${JSON.stringify(row)}\n`
      const bytes = Buffer.byteLength(line, "utf8")
      const file = this.fileFor(at)
      await this.ensureDirectory()
      if ((await this.fileSize(file)) + bytes > this.maxFileBytes) {
        throw new UsageLedgerError(
          "usage_ledger_full",
          `Usage ledger ${localDay(at)} is beyond its ${this.maxFileBytes}-byte cap`,
        )
      }
      const handle = await open(
        file,
        constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW,
        0o600,
      )
      try {
        await handle.chmod(0o600)
        await handle.writeFile(line)
      } finally {
        await handle.close()
      }
    })
  }

  /** Cost recorded for today, in micros. */
  spentToday(): Promise<number> {
    return this.run(async () => (await this.scan(localDay(this.now()))).costMicros)
  }

  /** Turns recorded for today, paid and free alike. */
  turnsToday(): Promise<number> {
    return this.run(async () => (await this.scan(localDay(this.now()))).turns)
  }

  /**
   * Paid turns recorded for today. A row counts as paid unless it explicitly
   * says `isFree: true`, so rows written before this counter existed still
   * count — the conservative direction for a budget.
   */
  paidTurnsToday(): Promise<number> {
    return this.run(async () => (await this.scan(localDay(this.now()))).paidTurns)
  }

  /** Corrupt lines skipped in today's file; the count resets with the day. */
  skippedToday(): Promise<number> {
    return this.run(async () => (await this.scan(localDay(this.now()))).skipped)
  }

  private fileFor(at: number): string {
    return join(this.directory, `${localDay(at)}.jsonl`)
  }

  private async ensureDirectory(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    // `mode` applies only on creation; tighten a pre-existing directory.
    await chmod(this.directory, 0o700)
  }

  private async fileSize(file: string): Promise<number> {
    try {
      const stat = await lstat(file)
      return stat.isFile() && !stat.isSymbolicLink() ? stat.size : 0
    } catch {
      return 0
    }
  }

  private async scan(day: string): Promise<UsageScan> {
    const file = join(this.directory, `${day}.jsonl`)
    let text: string
    try {
      const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        text = await handle.readFile("utf8")
      } finally {
        await handle.close()
      }
    } catch {
      // A missing day has no usage; an unreadable or replaced file is treated
      // the same way rather than failing the settings read.
      return { turns: 0, paidTurns: 0, costMicros: 0, skipped: 0 }
    }

    let turns = 0
    let paidTurns = 0
    let costMicros = 0
    let skipped = 0
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue
      const row = parseRow(line)
      if (!row) {
        skipped += 1
        continue
      }
      turns += row.turns
      if (row.isFree !== true) paidTurns += row.turns
      costMicros += row.costMicros
    }
    return { turns, paidTurns, costMicros, skipped }
  }
}
