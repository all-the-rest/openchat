/**
 * Fallbacks for a server that omits a knob. The shipped defaults are two
 * minutes or 25 MiB, whichever comes first (spec 04, dictation).
 */
export const DEFAULT_MAX_SECONDS = 120
export const DEFAULT_MAX_BYTES = 25 * 1024 * 1024
