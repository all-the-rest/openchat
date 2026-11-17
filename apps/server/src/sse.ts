/**
 * Event-stream constants shared by the route and the remote smoke check. This
 * module has no runtime dependencies, so the smoke CLI stays a black-box
 * client that never imports the server graph.
 */

/** How long the browser waits before reconnecting after a dropped stream. */
export const SSE_RETRY_FRAME = "retry: 2000"

/** Keepalive comment interval; the BFF writes `: heartbeat` every 15 s. */
export const SSE_HEARTBEAT_MS = 15_000
