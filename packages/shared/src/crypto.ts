import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Computes deterministic SHA-256 hash of a raw device key.
 * Used for fast and secure lookup of Bearer device keys in PostgreSQL.
 */
export function hashDeviceKey(rawKey: string): string {
  return createHash('sha256').update(rawKey.trim()).digest('hex');
}

/**
 * Constant-time comparison of two hex-encoded hashes using crypto.timingSafeEqual.
 * Prevents timing attacks on bearer token authentication.
 */
export function safeCompareHash(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length === 0 || bufB.length === 0 || bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Constant-time comparison of two arbitrary token strings by hashing both to fixed-length SHA-256 buffers.
 * Completely immune to length timing leaks, short-circuit string compares, or empty values.
 */
export function safeCompareTokens(token: string | undefined | null, expected: string): boolean {
  if (typeof token !== 'string' || typeof expected !== 'string') return false;
  const hashA = createHash('sha256').update(token.trim()).digest();
  const hashB = createHash('sha256').update(expected.trim()).digest();
  return timingSafeEqual(hashA, hashB);
}
