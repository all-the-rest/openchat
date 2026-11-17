export async function copyText(text: string): Promise<boolean> {
  if (typeof navigator === "undefined") return false
  const clipboard = navigator.clipboard
  if (!clipboard || typeof clipboard.writeText !== "function") return false
  try {
    await clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}
