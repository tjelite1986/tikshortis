/**
 * Embedding in another app (Grabbit's hub).
 *
 * Off unless EMBED_FRAME_ANCESTORS names the origins that may frame this app,
 * space separated, e.g. "https://grabbit.example.com". Unset, empty or
 * malformed means `frame-ancestors 'none'`, exactly as before the setting
 * existed: one bad entry turns the whole list off rather than letting a typo
 * widen it.
 *
 * Only plain origins are accepted: https://host[:port], or http:// for
 * localhost and 127.0.0.1 (local tests). No wildcards, paths or schemes like
 * data: — the header would accept them, and each one widens who can frame
 * the signed-in app.
 */

const ORIGIN_RE = /^https:\/\/[a-z0-9.-]+(:\d{1,5})?$/;
const LOCAL_RE = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/;

export function embedOrigins(raw: string | undefined | null): string[] {
  const parts = String(raw ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return [];
  const out: string[] = [];
  for (const p of parts) {
    const v = p.toLowerCase();
    if (!ORIGIN_RE.test(v) && !LOCAL_RE.test(v)) return [];
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

export function frameAncestors(raw: string | undefined | null): string {
  const list = embedOrigins(raw);
  return `frame-ancestors ${list.length ? list.join(" ") : "'none'"}`;
}
