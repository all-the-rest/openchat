/**
 * Private fake stack for the first-run E2E spec: the same deterministic host
 * as the main suite, but started without a model (`FAKE_MODELS=off`), so the
 * chat page has to onboard through the provider card before it can send.
 */
export const ONBOARDING_WEB_PORT = 5176
export const ONBOARDING_WEB_ORIGIN = `http://localhost:${ONBOARDING_WEB_PORT}`
export const ONBOARDING_BFF_PORT = 8793
/** Health checks and the Vite proxy talk to the socket address. */
export const ONBOARDING_BFF_ORIGIN = `http://127.0.0.1:${ONBOARDING_BFF_PORT}`
/**
 * `page.request` shares the browser cookie jar, which is scoped to the web
 * origin's host (`localhost`); use the same host for API probes.
 */
export const ONBOARDING_BFF_REQUEST_ORIGIN = `http://localhost:${ONBOARDING_BFF_PORT}`
