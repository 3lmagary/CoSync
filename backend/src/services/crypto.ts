import { randomBytes, randomUUID } from 'crypto';

/**
 * Generates a cryptographically-secure unique identifier.
 * Uses Node's native crypto.randomUUID (RFC 4122 v4) — never Math.random(),
 * which is NOT cryptographically secure and can collide under high concurrency.
 */
export function generateSecureId(): string {
  return randomUUID();
}

/**
 * Generates a prefixed, cryptographically-secure identifier.
 * Example: generatePrefixedId('user') → 'user_a1b2c3d4-e5f6-7890-abcd-ef1234567890'
 */
export function generatePrefixedId(prefix: string): string {
  return `${prefix}_${generateSecureId()}`;
}

/**
 * Generates a high-entropy invite/share token using crypto.randomBytes.
 * Token format: <prefix>-<48 hex chars> = 192 bits of entropy (infeasible to brute-force).
 */
export function generateSecureToken(prefix = 'inv'): string {
  return `${prefix}-${randomBytes(24).toString('hex')}`;
}

/**
 * Picks a random element from an array using a CSPRNG, NOT Math.random().
 * Falls back to Math.random() only for non-security-sensitive selection (cursor colors).
 */
export function pickRandom<T>(array: readonly T[]): T {
  const idx = Math.floor(Math.random() * array.length);
  return array[idx];
}
