import { db } from "./db";

/** One clip's watch report from the player: how far it got, and whether it finished. */
export type ViewReport = { id: number; watchMs: number; completed: boolean };

/** Upper bound on one report, so a stuck timer cannot write hours into a row. */
const MAX_WATCH_MS = 60 * 60 * 1000;

// Millisecond stamps: two clips left within the same second must still order
// on /history by which was left last.
const UPSERT = `INSERT INTO short_views (short_id, user_id, views, watch_ms, completed, first_viewed_at, last_viewed_at)
   VALUES (?, ?, 1, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
   ON CONFLICT(short_id, user_id) DO UPDATE SET
     views = views + 1,
     watch_ms = MAX(watch_ms, excluded.watch_ms),
     completed = MAX(completed, excluded.completed),
     last_viewed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;

/**
 * Records a batch of views for one viewer. Only clips that exist are written,
 * through the foreign key; a stale id in a beacon is skipped, not an error.
 * Statements are prepared inside the call: the connection opens on first use.
 */
export function recordViews(userId: number, reports: ViewReport[]): number {
  const upsert = db.prepare(UPSERT);
  const run = db.transaction((list: ViewReport[]) => {
    let written = 0;
    for (const r of list) {
      const watch = Math.max(0, Math.min(MAX_WATCH_MS, Math.round(r.watchMs)));
      try {
        upsert.run(r.id, userId, watch, r.completed ? 1 : 0);
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
