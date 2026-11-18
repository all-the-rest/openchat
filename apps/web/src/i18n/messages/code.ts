/**
 * Code surface states and actions.
 *
 * Explicit ids keep the public `t("key")` API stable; the German text lives in
 * `src/locales/de/messages.po`.
 */
import { msg } from "@lingui/core/macro"

export const code = {
  "code.barLabel": msg({ id: "code.barLabel", message: "Code surface controls" }),
  "code.state.loading": msg({ id: "code.state.loading", message: "Loading…" }),
  "code.state.ready": msg({ id: "code.state.ready", message: "Connected" }),
  "code.state.down": msg({ id: "code.state.down", message: "Not reachable" }),
  "code.state.ticket": msg({ id: "code.state.ticket", message: "Sign-in failed" }),
  "code.state.signedOut": msg({ id: "code.state.signedOut", message: "Signed out" }),
  "code.state.blocked": msg({ id: "code.state.blocked", message: "Embedding blocked" }),
  "code.state.offline": msg({ id: "code.state.offline", message: "Offline" }),
  "code.state.narrow": msg({ id: "code.state.narrow", message: "Desktop only" }),
  "code.reload": msg({ id: "code.reload", message: "Reload" }),
  "code.openNewTab": msg({ id: "code.openNewTab", message: "Open Code in a new tab" }),
  "code.openNewTabShort": msg({ id: "code.openNewTabShort", message: "New tab" }),
  "code.opensInNewTab": msg({ id: "code.opensInNewTab", message: "opens in a new tab" }),
  "code.focusFrame": msg({ id: "code.focusFrame", message: "Focus Code" }),
  "code.frameTitle": msg({ id: "code.frameTitle", message: "OpenCode workspace" }),
  "code.retry": msg({ id: "code.retry", message: "Retry" }),
  "code.downTitle": msg({ id: "code.downTitle", message: "Code host unreachable" }),
  "code.downStatus": msg({ id: "code.downStatus", message: "The health probe got no answer from the Code host." }),
  "code.ticketTitle": msg({ id: "code.ticketTitle", message: "No Code sign-in ticket" }),
  "code.ticketBody": msg({ id: "code.ticketBody", message: "The app could not create a sign-in ticket. The ticket limit may be exhausted; wait a minute and try again." }),
  "code.expectedVersion": msg({ id: "code.expectedVersion", message: "This app is built for OpenCode major version {version}." }),
  "code.versionMismatch": msg({ id: "code.versionMismatch", message: "The Code host runs OpenCode {version}; this app supports major version {expected}." }),
  "code.signedOutTitle": msg({ id: "code.signedOutTitle", message: "Sign in to open Code" }),
  "code.signedOutBody": msg({ id: "code.signedOutBody", message: "The Code host has no session in this browser. Signing in mints a fresh ticket." }),
  "code.signIn": msg({ id: "code.signIn", message: "Sign in to Code" }),
  "code.blockedTitle": msg({ id: "code.blockedTitle", message: "The Code interface could not be embedded" }),
  "code.blockedBody": msg({ id: "code.blockedBody", message: "The frame never finished loading. Open Code in a new tab instead." }),
  "code.offlineBody": msg({ id: "code.offlineBody", message: "You are offline. Code is not shown from cache; reconnect and reload." }),
  "code.mobileTitle": msg({ id: "code.mobileTitle", message: "Code needs a larger screen" }),
  "code.mobileBody": msg({ id: "code.mobileBody", message: "The Code interface is built for desktop. Open it in a new tab on this device." }),
} as const
