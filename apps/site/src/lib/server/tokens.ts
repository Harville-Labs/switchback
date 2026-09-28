/**
 * Secrets the site hands out (sign-in links, sessions, device tokens) are
 * random, prefixed so a leaked one is recognizable, and stored only as
 * SHA-256 hashes: a database leak doesn't expose usable credentials.
 */
import { createHash, randomBytes, randomInt } from 'node:crypto';

export function newSecret(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString('base64url')}`;
}

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/** No vowels (no accidental words) and no look-alike characters (RFC 8628 section 6.1). */
const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';

/** `WDJB-MJHT`: short enough to type, 20^8 possibilities, and it expires in minutes. */
export function newUserCode(): string {
  const pick = () => USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)];
  const half = () => Array.from({ length: 4 }, pick).join('');
  return `${half()}-${half()}`;
}

/** Accept what people type: any case, with or without the dash or spaces. */
export function normalizeUserCode(input: string): string {
  const s = input.toUpperCase().replace(/[^A-Z]/g, '');
  return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4)}` : s;
}

export function newId(): string {
  return crypto.randomUUID();
}
