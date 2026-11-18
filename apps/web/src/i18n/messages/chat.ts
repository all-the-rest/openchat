/**
 * Sign-in, chat list, transcript and composer.
 *
 * Explicit ids keep the public `t("key")` API stable; the German text lives in
 * `src/locales/de/messages.po`.
 */
import { msg } from "@lingui/core/macro"

export const chat = {
  "auth.loginTitle": msg({ id: "auth.loginTitle", message: "Sign in" }),
  "auth.loginDescription": msg({ id: "auth.loginDescription", message: "Enter your username and password to open the workspace." }),
  "auth.userLabel": msg({ id: "auth.userLabel", message: "Username" }),
  "auth.passwordLabel": msg({ id: "auth.passwordLabel", message: "Password" }),
  "auth.passwordPlaceholder": msg({ id: "auth.passwordPlaceholder", message: "Password" }),
  "auth.signIn": msg({ id: "auth.signIn", message: "Sign in" }),
  "auth.signingIn": msg({ id: "auth.signingIn", message: "Signing in…" }),
  "auth.signOut": msg({ id: "auth.signOut", message: "Sign out" }),
  "auth.invalidCredentials": msg({ id: "auth.invalidCredentials", message: "Wrong username or password. Try again." }),
  "auth.loginFailed": msg({ id: "auth.loginFailed", message: "Sign-in failed. Try again." }),
  "auth.bootFailed": msg({ id: "auth.bootFailed", message: "The app could not reach the server." }),
  "auth.retry": msg({ id: "auth.retry", message: "Retry" }),

  "session.untitled": msg({ id: "session.untitled", message: "Untitled" }),
  "session.listLabel": msg({ id: "session.listLabel", message: "Chat sessions" }),
  "session.empty": msg({ id: "session.empty", message: "No chats yet." }),
  "session.loading": msg({ id: "session.loading", message: "Loading chats…" }),
  "session.loadFailed": msg({ id: "session.loadFailed", message: "Chats could not be loaded." }),
  "session.createFailed": msg({ id: "session.createFailed", message: "Could not create a chat." }),

  "landing.heading": msg({ id: "landing.heading", message: "What do you want to work on?" }),
  "landing.description": msg({ id: "landing.description", message: "Send a message to start a new chat." }),

  "chat.transcript": msg({ id: "chat.transcript", message: "Chat transcript" }),
  "chat.youSaid": msg({ id: "chat.youSaid", message: "You said" }),
  "chat.assistantSaid": msg({ id: "chat.assistantSaid", message: "Assistant answer" }),
  "chat.loading": msg({ id: "chat.loading", message: "Loading messages…" }),
  "chat.loadFailed": msg({ id: "chat.loadFailed", message: "Messages could not be loaded." }),
  "chat.retry": msg({ id: "chat.retry", message: "Retry" }),
  "chat.sendFailed": msg({ id: "chat.sendFailed", message: "Your message could not be sent." }),
  "chat.stopFailed": msg({ id: "chat.stopFailed", message: "The run could not be stopped." }),
  "chat.connectionLost": msg({ id: "chat.connectionLost", message: "Connection lost — reconnecting…" }),
  "chat.reconnected": msg({ id: "chat.reconnected", message: "Reconnected" }),
  "chat.dismiss": msg({ id: "chat.dismiss", message: "Dismiss" }),
  "chat.statusReady": msg({ id: "chat.statusReady", message: "Ready" }),
  "chat.statusSubmitting": msg({ id: "chat.statusSubmitting", message: "Sending…" }),
  "chat.statusStreaming": msg({ id: "chat.statusStreaming", message: "Assistant is responding…" }),
  "chat.statusStopped": msg({ id: "chat.statusStopped", message: "Stopped" }),
  "chat.statusError": msg({ id: "chat.statusError", message: "Failed" }),
  "chat.statusQueued": msg({ id: "chat.statusQueued", message: "Queued" }),
  "chat.queuedHint": msg({ id: "chat.queuedHint", message: "Your message is queued until the current run finishes." }),
  "chat.inboxLabel": msg({ id: "chat.inboxLabel", message: "Queued messages" }),
  "chat.inboxCancel": msg({ id: "chat.inboxCancel", message: "Cancel" }),
  "chat.inboxPendingStep": msg({ id: "chat.inboxPendingStep", message: "Pending step" }),
  "chat.cancelFailed": msg({ id: "chat.cancelFailed", message: "The queued message could not be cancelled." }),
  "chat.continue": msg({ id: "chat.continue", message: "Continue" }),
  "chat.retryLast": msg({ id: "chat.retryLast", message: "Retry" }),
  "chat.answerComplete": msg({ id: "chat.answerComplete", message: "Answer complete" }),
  "chat.copied": msg({ id: "chat.copied", message: "Copied to clipboard" }),
  "chat.copyMessage": msg({ id: "chat.copyMessage", message: "Copy message" }),
  "chat.jumpToLatest": msg({ id: "chat.jumpToLatest", message: "Jump to latest message" }),

  "composer.label": msg({ id: "composer.label", message: "Message" }),
  "composer.placeholder": msg({ id: "composer.placeholder", message: "Send a message…" }),
  "composer.send": msg({ id: "composer.send", message: "Send" }),
  "composer.stop": msg({ id: "composer.stop", message: "Stop response" }),
  "composer.hint": msg({ id: "composer.hint", message: "Enter sends, Shift+Enter adds a line" }),

  "chat.modelLabel": msg({ id: "chat.modelLabel", message: "Model" }),
  "chat.agentLabel": msg({ id: "chat.agentLabel", message: "Agent" }),
  "chat.defaultChoice": msg({ id: "chat.defaultChoice", message: "Default" }),
  "chat.activeChoice": msg({ id: "chat.activeChoice", message: "Model: {model} · Agent: {agent}" }),

  "chat.permissionTitle": msg({ id: "chat.permissionTitle", message: "Permission required" }),
  "chat.permissionTool": msg({ id: "chat.permissionTool", message: "{tool} requests:" }),
  "chat.permissionResources": msg({ id: "chat.permissionResources", message: "Resources: {resources}" }),
  "chat.permissionAllowOnce": msg({ id: "chat.permissionAllowOnce", message: "Allow once" }),
  "chat.permissionAllowAlways": msg({ id: "chat.permissionAllowAlways", message: "Allow always" }),
  "chat.permissionDeny": msg({ id: "chat.permissionDeny", message: "Deny" }),
  "chat.permissionDenied": msg({ id: "chat.permissionDenied", message: "Denied {tool}" }),
  "chat.permissionDeniedGeneric": msg({ id: "chat.permissionDeniedGeneric", message: "A tool request was denied" }),
  "chat.permissionHint": msg({ id: "chat.permissionHint", message: "Answer this request before sending another message." }),
  "chat.permissionFailed": msg({ id: "chat.permissionFailed", message: "The reply could not be sent. Try again." }),
} as const
