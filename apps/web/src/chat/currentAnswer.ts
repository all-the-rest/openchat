/**
 * The latest assistant answer of the mounted chat, exposed to shell-level
 * actions (the command palette's "copy current answer") without a context that
 * would force the chat surface into every route's provider tree.
 */
let answer = ""
const listeners = new Set<() => void>()

export function setCurrentAnswer(text: string): void {
  if (text === answer) return
  answer = text
  for (const listener of listeners) listener()
}

export function getCurrentAnswer(): string {
  return answer
}

export function subscribeCurrentAnswer(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
