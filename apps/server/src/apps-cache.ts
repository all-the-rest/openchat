import type { AppsResponse } from "@openchat/contracts"
import { BackendError } from "@openchat/opencode"
import type { AppsSnapshot } from "@openchat/opencode"

/** A polling UI must not reach the host more than once per 10 s. */
export const APPS_CACHE_MS = 10_000

/** Reads the host's app surface; the default calls `backend.listApps`. */
export type AppsProbe = () => Promise<AppsSnapshot>

export interface AppsCacheOptions {
  probe: AppsProbe
  /** Injected clock for tests. */
  now?: () => number
  /** Cache lifetime; injectable so tests need not wait 10 s. */
  ttlMs?: number
}

/**
 * One short-lived read of the host's app surface, shared by `/api/apps` and
 * `/api/info` so the two never probe twice for one page load. A completed
 * answer — including "the host has no such surface" — is cached; a failure is
 * not, so a transient outage does not pin a 502 for the whole window.
 */
export class AppsCache {
  private readonly probe: AppsProbe
  private readonly now: () => number
  private readonly ttlMs: number
  private cached?: { at: number; value: AppsResponse }

  constructor(options: AppsCacheOptions) {
    this.probe = options.probe
    this.now = options.now ?? (() => Date.now())
    this.ttlMs = options.ttlMs ?? APPS_CACHE_MS
  }

  async get(): Promise<AppsResponse> {
    const at = this.now()
    if (this.cached && at - this.cached.at < this.ttlMs) return this.cached.value
    const value = await this.load()
    this.cached = { at, value }
    return value
  }

  /** Drops the snapshot; a connect/disconnect has changed the host. */
  invalidate(): void {
    this.cached = undefined
  }

  private async load(): Promise<AppsResponse> {
    try {
      const snapshot = await this.probe()
      return { available: true, servers: snapshot.servers, skills: snapshot.skills }
    } catch (error) {
      // A host that has no app surface is a deployment fact, not a failure:
      // the UI hides the entry instead of showing an error it cannot fix.
      if (error instanceof BackendError && error.code === "unsupported") {
        return { available: false, servers: [], skills: [] }
      }
      throw error
    }
  }
}

/**
 * The `/api/info` form of the same probe. It never throws, so an unreachable
 * host still boots and answers; `available` is then false.
 */
export async function probeApps(cache: AppsCache): Promise<boolean> {
  try {
    return (await cache.get()).available
  } catch {
    return false
  }
}
