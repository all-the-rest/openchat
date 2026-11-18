/**
 * Display name of the last signed-in user, kept only so an offline reload can
 * render the shell instead of a boot error. It is not a credential, not an API
 * response and never grants access: the session cookie still gates every API
 * call. Cleared on sign-out.
 */
const LAST_USER_KEY = "openchat.lastUser"

export function readLastUser(): string | null {
  try {
    return window.localStorage.getItem(LAST_USER_KEY)
  } catch {
    return null
  }
}

export function writeLastUser(user: string): void {
  try {
    window.localStorage.setItem(LAST_USER_KEY, user)
  } catch {
    // Best effort: the current session still works in memory.
  }
}

export function clearLastUser(): void {
  try {
    window.localStorage.removeItem(LAST_USER_KEY)
  } catch {
    // Best effort.
  }
}
