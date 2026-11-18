/**
 * Login credential configuration. Exactly one secret source is allowed, so a
 * deployment either carries the plaintext or a bcrypt hash — never both, where
 * one would silently win over the other.
 */

/**
 * A bcrypt hash is exactly 60 characters: `$2a$`/`$2b$`/`$2y$`, a two-digit
 * cost between 4 and 31, then a 53-character salt and digest. Hash tools used
 * by other stacks default to `$2a$`, which this accepts unchanged.
 */
export const BCRYPT_HASH_PATTERN =
  /^\$2[aby]\$(?:0[4-9]|[12]\d|3[01])\$[./A-Za-z0-9]{53}$/

export interface CredentialEnvInput {
  /** Raw `OPENCHAT_PASSWORD`; exact characters, `undefined` when unset. */
  password?: string
  /** Raw `OPENCHAT_PASSWORD_HASH`; exact characters, `undefined` when unset. */
  passwordHash?: string
}

export interface CredentialEnv {
  /** Plaintext credential; empty when a hash is configured. */
  password: string
  /** bcrypt hash; empty when a plaintext password is configured. */
  passwordHash: string
}

export function isBcryptHash(value: string): boolean {
  return BCRYPT_HASH_PATTERN.test(value)
}

/**
 * Requires exactly one of the two credentials. Both is a configuration
 * mistake, not a precedence rule: the operator would not know which one wins.
 * A malformed hash fails the boot because a login could never succeed with it.
 */
export function loadCredentialEnv(input: CredentialEnvInput): CredentialEnv {
  const password = input.password ?? ""
  const passwordHash = input.passwordHash ?? ""

  if (password && passwordHash) {
    throw new Error(
      "Set only one of OPENCHAT_PASSWORD and OPENCHAT_PASSWORD_HASH; both are configured",
    )
  }
  if (!password && !passwordHash) {
    throw new Error(
      "Set OPENCHAT_PASSWORD or OPENCHAT_PASSWORD_HASH; neither is configured",
    )
  }
  if (passwordHash && !isBcryptHash(passwordHash)) {
    throw new Error(
      "OPENCHAT_PASSWORD_HASH must be a bcrypt hash ($2a$, $2b$ or $2y$, 60 characters)",
    )
  }
  return { password, passwordHash }
}
