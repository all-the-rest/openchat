/**
 * First-run onboarding (issue #50).
 *
 * Explicit ids keep the public `t("key")` API stable; the German text lives in
 * `src/locales/de/messages.po`.
 */
import { msg } from "@lingui/core/macro"

export const onboarding = {
  "firstRun.title": msg({ id: "firstRun.title", message: "Connect a provider" }),
  "firstRun.description": msg({ id: "firstRun.description", message: "No model is available yet. Connect a provider to start chatting." }),
  "firstRun.loading": msg({ id: "firstRun.loading", message: "Loading providers…" }),
  "firstRun.loadFailed": msg({ id: "firstRun.loadFailed", message: "The provider list could not be loaded." }),
  "firstRun.retry": msg({ id: "firstRun.retry", message: "Retry" }),
  "firstRun.noProviders": msg({ id: "firstRun.noProviders", message: "The host reports no configurable provider. Use the host-side option below." }),
  "firstRun.stepProvider": msg({ id: "firstRun.stepProvider", message: "1. Choose a provider and connection method" }),
  "firstRun.methodLabel": msg({ id: "firstRun.methodLabel", message: "Connection method" }),
  "firstRun.stepDetails": msg({ id: "firstRun.stepDetails", message: "2. Enter the provider details" }),
  "firstRun.hostOnlyBadge": msg({ id: "firstRun.hostOnlyBadge", message: "on the host" }),
  "firstRun.hostOnly": msg({ id: "firstRun.hostOnly", message: "This method runs on the host. Run opencode auth login in a terminal on the server, then check again." }),
  "firstRun.connectedBadge": msg({ id: "firstRun.connectedBadge", message: "Connected" }),
  "firstRun.connected": msg({ id: "firstRun.connected", message: "Connected. The host now offers a model." }),
  "firstRun.noModelYet": msg({ id: "firstRun.noModelYet", message: "Connected, but the host still reports no model. Check the provider in OpenCode, then check again." }),
  "firstRun.verify": msg({ id: "firstRun.verify", message: "Check for models" }),
  "firstRun.verifying": msg({ id: "firstRun.verifying", message: "Checking…" }),
  "firstRun.verifyHint": msg({ id: "firstRun.verifyHint", message: "Reads the model catalogue again. Nothing is cached here." }),
  "firstRun.hostHint": msg({ id: "firstRun.hostHint", message: "Providers the app cannot configure are added on the host with opencode auth login." }),
  "firstRun.keyLabel": msg({ id: "firstRun.keyLabel", message: "API key" }),
  "firstRun.keyHint": msg({ id: "firstRun.keyHint", message: "Sent once to the host and never shown again." }),
  "firstRun.connect": msg({ id: "firstRun.connect", message: "Connect" }),
  "firstRun.connecting": msg({ id: "firstRun.connecting", message: "Connecting…" }),
  "firstRun.fieldUnset": msg({ id: "firstRun.fieldUnset", message: "Not set" }),
  "firstRun.error.catalogue": msg({ id: "firstRun.error.catalogue", message: "The host did not return its provider list. Try again." }),
  "firstRun.error.models": msg({ id: "firstRun.error.models", message: "The host did not return the model catalogue. Try again." }),
  "firstRun.error.form": msg({ id: "firstRun.error.form", message: "These provider details were rejected. Check the fields and try again." }),
  "firstRun.error.unsupported": msg({ id: "firstRun.error.unsupported", message: "This method is not available in the app. Use the host-side option." }),
  "firstRun.error.catalogEntry": msg({ id: "firstRun.error.catalogEntry", message: "This provider is no longer offered by the host. Reload the list." }),
  "firstRun.error.throttled": msg({ id: "firstRun.error.throttled", message: "Too many connection attempts. Try again shortly." }),
  "firstRun.error.throttledAfter": msg({ id: "firstRun.error.throttledAfter", message: "Too many connection attempts. Try again in {seconds} s." }),
  "firstRun.error.connect": msg({ id: "firstRun.error.connect", message: "The connection did not succeed. The host gave no confirmation." }),
  "firstRun.error.unknown": msg({ id: "firstRun.error.unknown", message: "Something went wrong. Try again." }),
  "firstRun.oauth.pending": msg({ id: "firstRun.oauth.pending", message: "Waiting for the provider…" }),
  "firstRun.oauth.start": msg({ id: "firstRun.oauth.start", message: "Start sign-in" }),
  "firstRun.oauth.starting": msg({ id: "firstRun.oauth.starting", message: "Starting…" }),
  "firstRun.oauth.open": msg({ id: "firstRun.oauth.open", message: "Open sign-in page" }),
  "firstRun.oauth.complete": msg({ id: "firstRun.oauth.complete", message: "I have approved access" }),
  "firstRun.oauth.completeCode": msg({ id: "firstRun.oauth.completeCode", message: "Complete sign-in" }),
  "firstRun.oauth.codeLabel": msg({ id: "firstRun.oauth.codeLabel", message: "Authorization code" }),
  "firstRun.oauth.codeHint": msg({ id: "firstRun.oauth.codeHint", message: "Paste the code the provider shows after approval." }),
  "firstRun.oauth.cancel": msg({ id: "firstRun.oauth.cancel", message: "Cancel sign-in" }),
  "firstRun.oauth.done": msg({ id: "firstRun.oauth.done", message: "Signed in." }),
  "firstRun.oauth.failed": msg({ id: "firstRun.oauth.failed", message: "The sign-in did not complete. Try again." }),
  "firstRun.oauth.expired": msg({ id: "firstRun.oauth.expired", message: "The sign-in expired. Start again." }),
} as const
