/**
 * Password hashing with Node's built-in scrypt — no native dependency, which
 * matters here: better-sqlite3 already has to be rebuilt against the
 * container's glibc, and a second compiled module would double that chore.
 *
 * Stored as `<salt hex>:<derived key hex>`. The format is deliberately the one
 * the accounts were created with in elite-v2, before this app had its own login, so a hash
 * copied across verifies here unchanged and nobody has to pick a new password.
 */
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const KEY_LEN = 64;

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const derived = scryptSync(password, salt, KEY_LEN).toString("hex");
  return `${salt}:${derived}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, derivedHex] = stored.split(":");
  if (!salt || !derivedHex) return false;
  const derived = Buffer.from(derivedHex, "hex");
  const candidate = scryptSync(password, salt, KEY_LEN);
  if (derived.length !== candidate.length) return false;
  return timingSafeEqual(derived, candidate);
}

/**
 * A hash no password matches, checked against when the email is unknown.
 *
 * Without it an unknown address answers in microseconds and a known one in the
 * time scrypt takes, and the difference is a list of who has an account.
 */
export const DUMMY_HASH = hashPassword(randomBytes(16).toString("hex"));
