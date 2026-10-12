import { db } from "./db";

/**
 * One clip's watch report from the player: how far it got, and whether it
 * finished. `continued`: the same stretch on screen was already reported when
 * the page was hidden, so this one only raises the figures, not the count.
 */
export type ViewReport = { id: number; watchMs: number; completed: boolean; continued?: boolean };

/** Upper bound on one report, so a stuck timer cannot write hours into a row. */
const MAX_WATCH_MS = 60 * 60 * 1000;

// Millisecond stamps, one per report: SQLite's 'now' is fixed for a whole
// transaction, so a beacon batch would otherwise share one stamp and /history
// would order it by id instead of by which clip was left last.
const UPSERT = `INSERT INTO short_views (short_id, user_id, views, watch_ms, completed, first_viewed_at, last_viewed_at)
   VALUES (?, ?, 1, ?, ?, ?, ?)
   ON CONFLICT(short_id, user_id) DO UPDATE SET
     views = views + ?,
     watch_ms = MAX(watch_ms, excluded.watch_ms),
     completed = MAX(completed, excluded.completed),
     last_viewed_at = excluded.last_viewed_at`;

/**
 * Records a batch of views for one viewer. Only clips that exist are written,
 * through the foreign key; a stale id in a beacon is skipped, not an error.
 * Statements are prepared inside the call: the connection opens on first use.
 */
export function recordViews(userId: number, reports: ViewReport[]): number {
  const upsert = db.prepare(UPSERT);
  const run = db.transaction((list: ViewReport[]) => {
    let written = 0;
    // Reports arrive in the order the clips were left; the last one is newest.
    const base = Date.now() - list.length;
    for (const [i, r] of list.entries()) {
      const watch = Math.max(0, Math.min(MAX_WATCH_MS, Math.round(r.watchMs)));
      const at = new Date(base + i + 1).toISOString();
      try {
        upsert.run(r.id, userId, watch, r.completed ? 1 : 0, at, at, r.continued ? 0 : 1);
        written++;
      } catch {
        /* unknown clip: the foreign key refused it */
      }
    }
    return written;
  });
  return run(reports);
}

/** Everything the ranker needs to know about what this viewer has watched. */
export function viewHistory(userId: number): Map<
  number,
  { views: number; watchMs: number; completed: boolean; lastViewedAt: string }
> {
  const rows = db
    .prepare(
      `SELECT short_id, views, watch_ms, completed, last_viewed_at
       FROM short_views WHERE user_id = ?`
    )
    .all(userId) as {
    short_id: number;
    views: number;
    watch_ms: number;
    completed: number;
    last_viewed_at: string;
  }[];
  return new Map(
    rows.map((r) => [
      r.short_id,
      {
        views: r.views,
        watchMs: r.watch_ms,
        completed: r.completed === 1,
        lastViewedAt: r.last_viewed_at,
      },
    ])
  );
}
