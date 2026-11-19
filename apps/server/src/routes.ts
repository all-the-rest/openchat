import type { Hono } from "hono"
import { STT_MODEL_ID } from "@openchat/contracts"
import type { ChatBackend } from "@openchat/opencode"
import { FakeHostSwitch, SUPPORTED_OPENCODE_MAJOR_LABEL } from "@openchat/opencode"
import { loginRequestSchema } from "@openchat/contracts"
import type {
  AppsSurfaceInfo,
  CodeSurfaceInfo,
  DictationInfo,
  InfoResponse,
  LoginResponse,
} from "@openchat/contracts"
import {
  clearSessionCookie,
  sessionCookie,
  verifyCredentials,
} from "./auth"
import type { AuthSettings, CredentialVerifier } from "./auth"
import type { AppEnv } from "./app"
import type { EnvConfig } from "./env"
import {
  BODY_TOO_LARGE,
  INVALID_JSON,
  invalidMessage,
  jsonError,
  payloadTooLarge,
  readJson,
} from "./http"
import { clientAddress } from "./middleware"
import { registerCatalogRoutes, registerFormRoutes, registerPermissionRoutes } from "./completion-routes"
import { registerSessionRoutes } from "./sessions"
import { registerPromptRoute } from "./prompt-route"
import { registerAppsRoutes } from "./apps"
import { AppsCache, probeApps } from "./apps-cache"
import type { AppsProbe } from "./apps-cache"
import { registerProviderRoutes } from "./providers"
import { artifactsSurface, registerArtifactsRoutes } from "./artifacts"
import type { ArtifactStatFsFn } from "./artifacts-internal"
import { registerArtifactInternalRoute } from "./artifacts-internal"
import { registerChatFilesRoutes } from "./chat-files"
import { createMemoryInvalidator } from "./memory-instructions"
import {
  registerMemoryInternalRoute,
  registerMemoryRoutes,
} from "./memory-route"
import { createMemoryStore } from "./memory-store"
import { registerCodeRoutes } from "./code"
import type { CodeProbe } from "./code"
import { registerSearchRoute } from "./search"
import { registerEventRoute } from "./events-route"
import { registerFakeControlsRoutes } from "./fake-controls"
import { registerFakeHostRoute } from "./fake-host-route"
import type { FixedWindowThrottle, VerificationGate } from "./throttle"
import { registerTranscribeRoute } from "./transcribe"
import { localModelAvailable } from "./models"
import { registerTasksRoutes } from "./tasks"
import { registerWorktreeRoutes } from "./worktrees"
import { registerFallbackRoute } from "./fallback-route"
import { registerBranchRoute } from "./branch-route"
import type { UsageLedger } from "./usage-ledger"

/** Fixed `Retry-After` for a login rejected by the concurrency gate. */
export const LOGIN_BUSY_RETRY_AFTER_SECONDS = 1

export interface RouteDeps {
  config: EnvConfig
  backend: ChatBackend
  settings: AuthSettings
  loginThrottle: FixedWindowThrottle
  /** Caps concurrent bcrypt rounds; shared by every login request. */
  verificationGate: VerificationGate
  /** Injected by tests to hold a verification open; defaults to bcrypt. */
  verify?: CredentialVerifier
  promptThrottle: FixedWindowThrottle
  /** Upstream STT deadline; injectable so tests need not wait 30 s. */
  sttTimeoutMs: number
  /** SSE keepalive interval; injectable so tests need not wait 15 s. */
  sseHeartbeatMs: number
  /** Ticket mint throttle, per client address. */
  codeTicketThrottle: FixedWindowThrottle
  codeProbe?: CodeProbe
  codeStatusCacheMs?: number
  codeNow?: () => number
  /** Connect/disconnect throttle, per client address. */
  appsActionThrottle: FixedWindowThrottle
  /** Provider connect attempts, per client address. */
  providerConnectThrottle: FixedWindowThrottle
  /** Injected for tests; the default reads `backend.listApps`. */
  appsProbe?: AppsProbe
  /** Pre-built cache, shared by `/api/apps` and `/api/info`. */
  appsCache?: AppsCache
  /** App snapshot cache lifetime; injectable so tests need not wait 10 s. */
  appsCacheMs?: number
  /** Injected clock for the app snapshot cache. */
  appsNow?: () => number
  /** Artifact creation throttle, per client address. */
  artifactsThrottle: FixedWindowThrottle
  /** Injected clock for signed artifact URLs. */
  artifactsNow?: () => number
  /** Filesystem probe for the artifact write capacity guard. */
  artifactsStatfs?: ArtifactStatFsFn
  /** Capacity threshold for the artifact write capacity guard. */
  artifactsFullThreshold?: number
  /** How long a prompt waits for a compaction decision; tests shorten it. */
  compactionWaitMs?: number
  /** Fallback engine, resolved policy and the shared usage ledger. */
  fallback?: import("./fallback-engine").FallbackEngine
  chatPolicy: import("@openchat/contracts").TurnPolicy
  /** `FALLBACK_CHAIN_JSON` validation message when the supplied value was rejected. */
  chainInvalidReason?: string
  /** Ledger the engine writes and `/api/fallback` reads. */
  usageLedger: UsageLedger
  /** Server-owned merged event stream for the SSE route. */
  events: import("./events-route").EventSource
}

function registerAuthRoutes(app: Hono<AppEnv>, deps: RouteDeps): void {
  const { config, settings, loginThrottle, verificationGate } = deps
  const verify = deps.verify ?? verifyCredentials

  app.post("/api/auth/login", async (c) => {
    const body = await readJson(c)
    if (body === BODY_TOO_LARGE) return payloadTooLarge(c)
    if (body === INVALID_JSON) {
      return jsonError(c, 400, "invalid_request", "Invalid JSON body")
    }
    const parsed = loginRequestSchema.safeParse(body)
    if (!parsed.success) {
      return jsonError(c, 400, "invalid_request", invalidMessage(parsed.error))
    }

    const address = clientAddress(c, config.TRUST_PROXY)
    const throttle = loginThrottle.check(address)
    if (throttle.limited) {
      c.header("Retry-After", String(throttle.retryAfterSeconds))
      return jsonError(c, 429, "too_many_requests", "Too many failed login attempts")
    }

    // Every attempt is counted before the password check, so a parallel burst
    // cannot all reach bcrypt while the budget still reads empty. A success
    // resets the bucket, exactly as before: a successful attempt therefore does
    // not stay counted for the rest of the window, it clears the failures in
    // front of it. An address that never succeeds is blocked on the attempt
    // after its tenth inside the window, whether that attempt was cheap or not.
    loginThrottle.record(address)
    if (!verificationGate.tryAcquire()) {
      c.header("Retry-After", String(LOGIN_BUSY_RETRY_AFTER_SECONDS))
      return jsonError(c, 429, "server_busy", "Too many concurrent login attempts")
    }

    let user: string | null
    try {
      user = await verify(parsed.data.user, parsed.data.password, settings)
    } finally {
      // Also runs when bcrypt throws on a malformed hash, so a bad row in the
      // environment cannot wedge the gate shut.
      verificationGate.release()
    }
    if (!user) {
      return jsonError(c, 401, "invalid_credentials", "Invalid user or password")
    }
    loginThrottle.reset(address)
    if (config.AUTH_MODE === "session") {
      c.header("Set-Cookie", sessionCookie(settings))
    }
    return c.json({ user } satisfies LoginResponse)
  })

  app.get("/api/auth/me", (c) =>
    c.json({ user: c.get("user") } satisfies LoginResponse),
  )

  app.post("/api/auth/logout", (c) => {
    c.header("Set-Cookie", clearSessionCookie(settings))
    return c.body(null, 204)
  })
}

function registerInfoRoutes(app: Hono<AppEnv>, deps: RouteDeps, appsCache: AppsCache): void {
  const { config, backend } = deps

  app.get("/api/info", async (c) => {
    // A partial or absent model set disables the on-device path without ever
    // hiding the microphone when the server STT is configured.
    const localAvailable = await localModelAvailable(config.STT_MODEL_DIR)
    const serverAvailable = Boolean(config.STT_URL)
    // The host may be unreachable (a dead tunnel is a normal operating state),
    // so the three host calls settle independently: one answer proves the host
    // is up, and a failed fragment degrades instead of failing the page load.
    const appsProbe = probeApps(appsCache)
    const [info, models, agents] = await Promise.allSettled([
      backend.info(),
      backend.listModels(),
      backend.listAgents(),
    ])
    const appsAvailable = await appsProbe

    const hostReachable =
      info.status === "fulfilled" ||
      models.status === "fulfilled" ||
      agents.status === "fulfilled"

    c.header("Cache-Control", "no-store")
    return c.json({
      host: { reachable: hostReachable },
      server: info.status === "fulfilled" ? info.value : null,
      models: models.status === "fulfilled" ? models.value : [],
      agents: agents.status === "fulfilled" ? agents.value : [],
      scenario: config.BACKEND_MODE === "fake" ? config.FAKE_SCENARIO : "live",
      dictation: {
        enabled: serverAvailable || localAvailable,
        maxSeconds: config.DICTATION_MAX_SECONDS,
        maxBytes: config.DICTATION_MAX_BYTES,
        local: { available: localAvailable, model: STT_MODEL_ID },
        server: { available: serverAvailable },
      } satisfies DictationInfo,
      code: {
        configured: Boolean(config.CODE_HOST_ORIGIN),
        expectedVersion: SUPPORTED_OPENCODE_MAJOR_LABEL,
      } satisfies CodeSurfaceInfo,
      apps: { available: appsAvailable } satisfies AppsSurfaceInfo,
      artifacts: artifactsSurface(config),
    } satisfies InfoResponse)
  })
}

/** Registers every API route; the guards and authentication run before it. */
export function registerRoutes(app: Hono<AppEnv>, deps: RouteDeps): void {
  // One cache for both `/api/apps` and `/api/info`: a page load probes once.
  const appsCache =
    deps.appsCache ??
    new AppsCache({
      probe: deps.appsProbe ?? (() => deps.backend.listApps()),
      ttlMs: deps.appsCacheMs,
      now: deps.appsNow,
    })

  const memoryStore = createMemoryStore({
    dir: deps.config.MEMORY_DATA_DIR,
    maxFactsBytes: deps.config.MEMORY_MAX_FACTS_BYTES,
  })
  const memoryInvalidator = createMemoryInvalidator(deps.backend, memoryStore)

  registerAuthRoutes(app, deps)
  registerInfoRoutes(app, deps, appsCache)
  registerCatalogRoutes(app, deps.backend)
  registerProviderRoutes(app, {
    backend: deps.backend,
    config: deps.config,
    connectThrottle: deps.providerConnectThrottle,
  })
  registerSessionRoutes(app, {
    config: deps.config,
    backend: deps.backend,
    memory: { store: memoryStore, invalidator: memoryInvalidator },
  })
  registerBranchRoute(app, { backend: deps.backend, noteSession: (id) => memoryInvalidator.noteSession(id) })
  registerPromptRoute(app, deps)
  registerFallbackRoute(app, { policy: deps.chatPolicy, ledger: deps.usageLedger, invalidReason: deps.chainInvalidReason })
  registerPermissionRoutes(app, deps.backend)
  registerFormRoutes(app, deps.backend)
  registerCodeRoutes(app, {
    config: deps.config,
    ticketThrottle: deps.codeTicketThrottle,
    probe: deps.codeProbe,
    statusCacheMs: deps.codeStatusCacheMs,
    now: deps.codeNow,
  })
  registerAppsRoutes(app, {
    backend: deps.backend,
    cache: appsCache,
    config: deps.config,
    actionThrottle: deps.appsActionThrottle,
  })
  registerArtifactsRoutes(app, {
    config: deps.config,
    createThrottle: deps.artifactsThrottle,
    now: deps.artifactsNow,
  })
  registerArtifactInternalRoute(app, {
    config: deps.config,
    now: deps.artifactsNow,
    statfs: deps.artifactsStatfs,
    fullThreshold: deps.artifactsFullThreshold,
  })
  registerMemoryInternalRoute(app, {
    config: deps.config,
    store: memoryStore,
    invalidator: memoryInvalidator,
  })
  registerMemoryRoutes(app, {
    config: deps.config,
    store: memoryStore,
    backends: deps.backend,
    invalidator: memoryInvalidator,
  })
  registerChatFilesRoutes(app, deps.config)
  registerSearchRoute(app, deps.backend)
  registerTranscribeRoute(app, deps)
  registerTasksRoutes(app, { backend: deps.backend })
  registerWorktreeRoutes(app, { backend: deps.backend })
  registerEventRoute(app, deps)
  // Fake mode only; the live adapter has no outage switch to expose.
  if (deps.config.BACKEND_MODE === "fake") {
    if (deps.backend instanceof FakeHostSwitch) registerFakeHostRoute(app, deps.backend)
    registerFakeControlsRoutes(app, deps.backend)
  }
}
