/**
 * A second, isolated app + BFF pair for the host-outage E2E. The main suite
 * shares one fake backend across four workers, so flipping that backend down
 * would fail unrelated tests; this pair exists only for the outage spec.
 */
export const HOST_STATUS_WEB_PORT = 5174
export const HOST_STATUS_WEB_ORIGIN = `http://localhost:${HOST_STATUS_WEB_PORT}`
export const HOST_STATUS_BFF_PORT = 8788
export const HOST_STATUS_BFF_ORIGIN = `http://localhost:${HOST_STATUS_BFF_PORT}`
