/**
 * Fixed-window per-key ceiling, in memory: `node server.js` is one process, so
 * a Map is the whole mechanism, and it resets on restart. It is an abuse
 * ceiling for endpoints that cost the server something per call (an outbound
 * fetch, a decode), not a quota a person using the site normally reaches.
 */

type Window = { count: number; resetAt: number };

const buckets = new Map<string, Window>();

function sweep(now: number): void {
  if (buckets.size < 5000) return;
  for (const [k, w] of buckets) if (w.resetAt < now) buckets.delete(k);
}

/** Counts one call under `bucket` for `key`; false once over `limit` in the window. */
export function allow(
  bucket: string,
  key: string | number,
  limit: number,
  windowMs: number
): { ok: boolean; retryAfter: number } {
  const now = Date.now();
  sweep(now);
  const k = `${bucket}:${key}`;
  const w = buckets.get(k);
  if (!w || w.resetAt <= now) {
    buckets.set(k, { count: 1, resetAt: now + windowMs });
    return { ok: true, retryAfter: 0 };
  }
  w.count++;
  if (w.count > limit) return { ok: false, retryAfter: Math.ceil((w.resetAt - now) / 1000) };
  return { ok: true, retryAfter: 0 };
}
