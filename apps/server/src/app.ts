import { Hono } from "hono"
import { BackendError } from "@openchat/opencode"
import type { ChatBackend } from "@openchat/opencode"
import type { CredentialVerifier } from "./auth"
import { APPS_ACTION_LIMIT, APPS_ACTION_WINDOW_MS } from "./apps"
import { AppsCache } from "./apps-cache"
import type { AppsProbe } from "./apps-cache"
import { ARTIFACT_CREATE_LIMIT, ARTIFACT_CREATE_WINDOW_MS } from "./artifacts"
import type { ArtifactStatFsFn } from "./artifacts-internal"
import type { CodeProbe } from "./code"
import { CODE_TICKET_LIMIT, CODE_TICKET_WINDOW_MS } from "./code"
import type { EnvConfig } from "./env"
import { jsonError } from "./http"
import {
  authSettings,
  registerAuthentication,
  registerRequestGuards,
} from "./middleware"
import { PROVIDER_CONNECT_LIMIT, PROVIDER_CONNECT_WINDOW_MS } from "./providers"
import { registerRoutes } from "./routes"
import { SSE_HEARTBEAT_MS } from "./sse"
import { FixedWindowThrottle, VerificationGate } from "./throttle"
import { STT_TIMEOUT_MS } from "./transcribe"
import { UsageLedger } from "./usage-ledger"
import { FallbackEngine } from "./fallback-engine"
import { resolveChatPolicy, validateChainJson } from "./fallback-config"
import type { TurnPolicy } from "@openchat/contracts"

export const SERVER_VERSION = "2.5.0"

/** Per-address prompt budget: 30 accepted prompts in a rolling 60 s window. */
export const PROMPT_LIMIT = 30
export const PROMPT_WINDOW_MS = 60_000

export interface AppOptions {
  config: EnvConfig
  backend: ChatBackend
  version?: string
  /** Upstream STT deadline in milliseconds; tests shorten it. */
  sttTimeoutMs?: number
  /** SSE keepalive interval in milliseconds; tests shorten it. */
  sseHeartbeatMs?: number
  /** Code host health probe; injected so tests never touch the network. */
  codeProbe?: CodeProbe
  /** Status cache lifetime in milliseconds; tests shorten it. */
  codeStatusCacheMs?: number
  /** Clock for the status cache; tests advance it. */
  codeNow?: () => number
  /** Ticket throttle; tests inject a clock-bound instance. */
  codeTicketThrottle?: FixedWindowThrottle
  /** App surface probe; injected so tests need not use the backend. */
  appsProbe?: AppsProbe
  /** Pre-built app cache; the default shares one instance across the routes. */
  appsCache?: AppsCache
  /** App snapshot cache lifetime in milliseconds; tests shorten it. */
  appsCacheMs?: number
  /** Clock for the app snapshot cache; tests advance it. */
  appsNow?: () => number
  /** App action throttle; tests inject a clock-bound instance. */
  appsActionThrottle?: FixedWindowThrottle
  /** Provider connect throttle; tests inject a clock-bound instance. */
  providerConnectThrottle?: FixedWindowThrottle
  /** Artifact creation throttle; tests inject a clock-bound instance. */
  artifactsThrottle?: FixedWindowThrottle
  /** Clock for signed artifact URLs; tests advance it. */
  artifactsNow?: () => number
  /** Filesystem probe for the artifact write capacity guard; injectable in tests. */
  artifactsStatfs?: ArtifactStatFsFn
  /** Capacity threshold for the artifact write guard; injectable in tests. */
  artifactsFullThreshold?: number
  /** Credential verifier; tests inject one they can hold open. */
  verify?: CredentialVerifier
  /** Login concurrency gate; tests shrink it to one permit. */
  verificationGate?: VerificationGate
  /** Bounded wait for a compaction decision before a prompt; tests shorten it. */
  compactionWaitMs?: number
  /** Injected fallback engine; tests supply one with a stubbed ledger. */
  fallback?: FallbackEngine
  /** Injected resolved chat policy; tests narrow the chain. */
  chatPolicy?: TurnPolicy
  /** Boot warning sink; tests capture it, production defaults to `console.warn`. */
  warn?: (message: string) => void
}

export interface AppVariables {
  user: string
}

/**
 * Values the node adapter passes per request. `remoteAddress` is the socket
 * peer, not a client header, so it cannot be spoofed.
 */
export interface AppBindings {
  remoteAddress?: string
}

export type AppEnv = { Bindings: AppBindings; Variables: AppVariables }

export function createApp(options: AppOptions): Hono<AppEnv> {
  const { config, backend } = options
  const version = options.version ?? SERVER_VERSION
  const settings = authSettings(config)
  const loginThrottle = new FixedWindowThrottle()
  const verificationGate = options.verificationGate ?? new VerificationGate()
  const promptThrottle = new FixedWindowThrottle({
    limit: PROMPT_LIMIT,
    windowMs: PROMPT_WINDOW_MS,
  })
  const codeTicketThrottle =
    options.codeTicketThrottle ??
    new FixedWindowThrottle({
      limit: CODE_TICKET_LIMIT,
      windowMs: CODE_TICKET_WINDOW_MS,
    })
  const appsActionThrottle =
    options.appsActionThrottle ??
    new FixedWindowThrottle({
      limit: APPS_ACTION_LIMIT,
      windowMs: APPS_ACTION_WINDOW_MS,
    })
  const providerConnectThrottle =
    options.providerConnectThrottle ??
    new FixedWindowThrottle({
      limit: PROVIDER_CONNECT_LIMIT,
      windowMs: PROVIDER_CONNECT_WINDOW_MS,
    })
  const artifactsThrottle =
    options.artifactsThrottle ??
    new FixedWindowThrottle({
      limit: ARTIFACT_CREATE_LIMIT,
      windowMs: ARTIFACT_CREATE_WINDOW_MS,
    })
  // Model fallback: the ledger is cheap and side-effect-free at construction;
  // an invalid chain JSON only disables fallback rather than failing boot.
  const warn = options.warn ?? ((message: string) => console.warn(`[openchat] ${message}`))
  let chain: ReturnType<typeof validateChainJson> = []
  if (config.FALLBACK_CHAIN_JSON.trim() !== "") {
    try {
      chain = validateChainJson(config.FALLBACK_CHAIN_JSON)
    } catch (error) {
      // One boot warning, with the validation message only: the raw value can
      // carry credentials or private endpoints and never belongs in a log.
      const reason = error instanceof Error ? error.message : "unknown validation error"
      warn(`FALLBACK_CHAIN_JSON is invalid; fallback stays disabled: ${reason}`)
    }
  }
  const chatPolicy = options.chatPolicy ?? resolveChatPolicy({
    chain,
    paidDailyTurns: config.FALLBACK_PAID_DAILY_CAP,
    contextSoftCap: config.CHAT_CONTEXT_SOFT_CAP,
  })
  const fallback = options.fallback ?? new FallbackEngine({
    backend,
    ledger: new UsageLedger({ directory: config.FALLBACK_USAGE_DIR }),
    warn,
  })

  const app = new Hono<AppEnv>()

  app.onError((error, c) => {
    if (error instanceof BackendError) {
      const status =
        error.code === "not_found" ? 404 : error.code === "conflict" ? 409 : 400
      return jsonError(c, status, error.code, error.message)
    }
    return jsonError(c, 500, "internal_error", "Unexpected server error")
  })

  app.get("/healthz", (c) =>
    c.json({ ok: true, mode: config.BACKEND_MODE, version }),
  )

  registerRequestGuards(app)
  registerAuthentication(app, settings, { config, loginThrottle })
  registerRoutes(app, {
    config,
    backend,
    settings,
    loginThrottle,
    verificationGate,
    verify: options.verify,
    promptThrottle,
    sttTimeoutMs: options.sttTimeoutMs ?? STT_TIMEOUT_MS,
    sseHeartbeatMs: options.sseHeartbeatMs ?? SSE_HEARTBEAT_MS,
    codeTicketThrottle,
    codeProbe: options.codeProbe,
    codeStatusCacheMs: options.codeStatusCacheMs,
    codeNow: options.codeNow,
    appsActionThrottle,
    providerConnectThrottle,
    appsProbe: options.appsProbe,
    appsCache: options.appsCache,
    appsCacheMs: options.appsCacheMs,
    appsNow: options.appsNow,
    artifactsThrottle,
    artifactsNow: options.artifactsNow,
    artifactsStatfs: options.artifactsStatfs,
    artifactsFullThreshold: options.artifactsFullThreshold,
    compactionWaitMs: options.compactionWaitMs,
    fallback,
    chatPolicy,
  })

  return app
}
