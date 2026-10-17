/**
 * Failed sign-ins, counted per client address and per email.
 *
 * The login answers on a public hostname, so something has to stand between it
 * and a password list. In memory, not in the database: a restart forgetting
 * the counts costs an attacker nothing they could not get by waiting, and a
 * table would be written on every bad guess.
 *
 * Both keys are counted because each one alone has a hole: per address misses
 * a spread of addresses against one account, per email lets one address try
 * every account.
 */
const WINDOW_MS = 15 * 60_000;
const MAX_FAILURES = 10;

type Entry = { count: number; first: number };
const failures = new Map<string, Entry>();

function live(key: string, now: number): Entry | null {
  const entry = failures.get(key);
  if (!entry) return null;
  if (now - entry.first >= WINDOW_MS) {
    failures.delete(key);
    return null;
  }
  return entry;
}

/**
 * The address the request came from. Only headers a proxy overwrites:
 * Cloudflare sets `cf-connecting-ip`, Traefik sets `x-real-ip`. The leftmost
 * `x-forwarded-for` hop is whatever the client chose to send, so it is never
 * read — trusting it would hand every attempt a fresh counter.
 */
export function clientAddress(req: Request): string {
  return (
    req.headers.get("cf-connecting-ip") ??
    req.headers.get("x-real-ip") ??
    "unknown"
  );
}

/** Seconds until the next attempt is allowed, or 0 when it is allowed now. */
export function retryAfter(keys: string[]): number {
  const now = Date.now();
  let wait = 0;
  for (const key of keys) {
    const entry = live(key, now);
    if (entry && entry.count >= MAX_FAILURES) {
      wait = Math.max(wait, Math.ceil((entry.first + WINDOW_MS - now) / 1000));
    }
  }
  return wait;
}

export function recordFailure(keys: string[]): void {
  const now = Date.now();
  for (const [key, entry] of failures) {
    if (now - entry.first >= WINDOW_MS) failures.delete(key);
  }
  for (const key of keys) {
    const entry = live(key, now);
    if (entry) entry.count += 1;
    else failures.set(key, { count: 1, first: now });
  }
}

export function clearFailures(keys: string[]): void {
  for (const key of keys) failures.delete(key);
}
