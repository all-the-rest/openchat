/**
 * Numeric limits of the artifact iframe bridge
 * ([`18-artifact-bridge.md`](../../../docs/implementation/18-artifact-bridge.md)
 * "Limits").
 *
 * Both halves import these values: the host shim interpolates them into the
 * script it emits, and the viewer clamps and truncates with them. One owner,
 * so raising a cap on one side cannot silently leave the other truncating or
 * rejecting at the old number.
 *
 * No imports: the web bundle embeds this module, and the shim path must not
 * pull the schema code (or `zod`) along with four numbers.
 */

/**
 * Largest accepted `artifact:result`, as UTF-8 bytes of its JSON. The shim
 * refuses to post above it; the viewer refuses to accept above it.
 */
export const ARTIFACT_RESULT_MAX_BYTES = 64 * 1024

/**
 * Longest accepted result title, in **code points**. Both ends truncate with
 * `Array.from`, so an emoji at the boundary is kept or dropped whole.
 */
export const ARTIFACT_RESULT_TITLE_MAX = 200

/** Lowest frame height an artifact may request, in CSS pixels. */
export const ARTIFACT_HEIGHT_MIN = 80

/** Highest frame height an artifact may request; above it the frame scrolls. */
export const ARTIFACT_HEIGHT_MAX = 4_000
