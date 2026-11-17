export function createID(prefix: string): string {
  const cryptoApi = typeof crypto !== "undefined" ? crypto : undefined
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") {
    return `${prefix}_${cryptoApi.randomUUID()}`
  }
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}
