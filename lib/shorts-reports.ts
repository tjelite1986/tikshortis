import { db } from "./db";
import type { ReportReason } from "./report-reasons";

// Reports: a viewer flagging a clip for an admin. The data side of the
// /api/shorts/[id]/report and /api/admin/shorts/reports routes, kept here so the
// tsx scratch test can drive it without Next.

export const REPORT_NOTE_MAX = 500;

// One report per viewer and clip: a repeat replaces the reason and note and
// reopens the report if an admin had dismissed it. Reporting also hides the
// clip from the reporter's own feed (the same row "Not interested" writes), so
// the clip is gone for them the moment they send it.
export function reportShort(
  shortId: number,
  userId: number,
  reason: ReportReason,
  note: string | null,
): void {
  const trimmed = note?.trim().slice(0, REPORT_NOTE_MAX) || null;
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO short_reports (short_id, user_id, reason, note)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(short_id, user_id) DO UPDATE SET
         reason = excluded.reason,
         note = excluded.note,
         created_at = datetime('now'),
         resolved_at = NULL`,
    ).run(shortId, userId, reason, trimmed);
    db.prepare(
      "INSERT OR IGNORE INTO short_hides (short_id, user_id) VALUES (?, ?)",
    ).run(shortId, userId);
  });
  tx();
}

export interface OpenReport {
  reporter: string | null;
  reason: string;
  note: string | null;
  created_at: string;
}

export interface ReportedShort {
  id: number;
  caption: string | null;
  profile_name: string | null;
  uploader_name: string | null;
  has_poster: boolean;
  poster_v: string | null;
  report_count: number;
  latest_at: string;
  reports: OpenReport[];
}

// Poster cache token, same derivation as getFeed's (djb2 → base36).
function posterVersion(key: string): string {
  let h = 5381;
  for (let i = 0; i < key.length; i++)
    h = ((h << 5) + h + key.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// Every clip with at least one open report, most recently reported first.
// A soft-deleted clip drops out on its own: there is nothing left to judge.
export function listReportedShorts(): ReportedShort[] {
  const rows = db
    .prepare(
      `SELECT rp.short_id, rp.reason, rp.note, rp.created_at,
              COALESCE(u.display_name, u.username, substr(u.email, 1, instr(u.email, '@') - 1)) AS reporter,
              s.caption, s.poster_key, p.name AS profile_name,
              COALESCE(up.display_name, up.username, substr(up.email, 1, instr(up.email, '@') - 1)) AS uploader_name
       FROM short_reports rp
       JOIN shorts s ON s.id = rp.short_id
       LEFT JOIN users u ON u.id = rp.user_id
       LEFT JOIN users up ON up.id = s.uploader_id
       LEFT JOIN short_profiles p ON p.id = s.profile_id
       WHERE rp.resolved_at IS NULL AND s.is_deleted = 0
       ORDER BY rp.created_at DESC, rp.id DESC`,
    )
    .all() as {
    short_id: number;
    reason: string;
    note: string | null;
    created_at: string;
    reporter: string | null;
    caption: string | null;
    poster_key: string | null;
    profile_name: string | null;
    uploader_name: string | null;
  }[];
  const byShort = new Map<number, ReportedShort>();
  for (const r of rows) {
    let entry = byShort.get(r.short_id);
    if (!entry) {
      entry = {
        id: r.short_id,
        caption: r.caption,
        profile_name: r.profile_name,
        uploader_name: r.uploader_name,
        has_poster: Boolean(r.poster_key),
        poster_v: r.poster_key ? posterVersion(r.poster_key) : null,
        report_count: 0,
        latest_at: r.created_at,
        reports: [],
      };
      byShort.set(r.short_id, entry);
    }
    entry.report_count++;
    entry.reports.push({
      reporter: r.reporter,
      reason: r.reason,
      note: r.note,
      created_at: r.created_at,
    });
  }
  return [...byShort.values()];
}

// Admin: close every open report on a clip. The rows stay (a repeat report
// from the same viewer reopens theirs), so a clip that keeps getting flagged
// keeps its history. Returns how many were closed.
export function dismissReports(shortId: number): number {
  return db
    .prepare(
      "UPDATE short_reports SET resolved_at = datetime('now') WHERE short_id = ? AND resolved_at IS NULL",
    )
    .run(shortId).changes;
}

// Open reports in total, for a badge.
export function countOpenReports(): number {
  const row = db
    .prepare(
      `SELECT COUNT(DISTINCT rp.short_id) AS n FROM short_reports rp
       JOIN shorts s ON s.id = rp.short_id
       WHERE rp.resolved_at IS NULL AND s.is_deleted = 0`,
    )
    .get() as { n: number };
  return row.n;
}
