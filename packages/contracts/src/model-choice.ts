/**
 * One rule for a persisted model choice, shared by the browser and the BFF.
 * The catalogue is authoritative: a model id resolves through it first, and a
 * variant survives only while its model still offers it. Keeping the rule here
 * means the composer and the chain cannot disagree about what may be sent.
 */
export function offeredVariant(
  variant: string | undefined,
  variants: readonly string[],
): string | undefined {
  return variant !== undefined && variants.includes(variant) ? variant : undefined
}
