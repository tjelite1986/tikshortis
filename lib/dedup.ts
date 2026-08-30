import { db } from "./db";

/**
 * Pairs a person has looked at and called "not duplicates".
 *
 * In elite-v2 this lived in a shared `media_dupe_dismissals` table serving three
 * libraries, and the shorts scanner never read it — dismissing a group there
 * writes rows that the next scan does not consult, so the group comes back. The
 * table came across because the button did; the scanner reading it is the part
 * that was missing, and `scripts/scan-shorts-duplicates.mjs` now skips a pair
 * that appears here.
 *
 * Stored with the lower id first so the pair has one representation regardless
 * of which order the caller saw them in.
 */
function pairKey(a: number, b: number): [number, number] {
  return a <= b ? [a, b] : [b, a];
}

export function dismissPair(a: number, b: number): void {
  const [lo, hi] = pairKey(a, b);
  db.prepare(
    "INSERT OR IGNORE INTO short_dupe_dismissals (a_id, b_id) VALUES (?, ?)"
  ).run(lo, hi);
}

export function undismissPair(a: number, b: number): void {
  const [lo, hi] = pairKey(a, b);
  db.prepare(
    "DELETE FROM short_dupe_dismissals WHERE a_id = ? AND b_id = ?"
  ).run(lo, hi);
}

/** Every dismissed pair as "lo:hi" keys, for a scan to filter against. */
export function dismissedPairs(): Set<string> {
  const rows = db
    .prepare("SELECT a_id, b_id FROM short_dupe_dismissals")
    .all() as { a_id: number; b_id: number }[];
  return new Set(rows.map((r) => `${r.a_id}:${r.b_id}`));
}

export function dismissedCount(): number {
  return (
    db
      .prepare("SELECT COUNT(*) AS n FROM short_dupe_dismissals")
      .get() as { n: number }
  ).n;
}
