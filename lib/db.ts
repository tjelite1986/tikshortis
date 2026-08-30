import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "fs";
import path from "path";

// Resolve the data directory (mounted as a named volume in Docker).
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");
if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, "tikshortis.db");

// Reuse a single connection across hot reloads in dev.
const globalForDb = globalThis as unknown as { db?: Database.Database };

function createDb(): Database.Database {
  const db = new Database(DB_PATH);
  // Wait for a busy DB instead of failing immediately. Must be the FIRST pragma:
  // on a fresh file, parallel `next build` workers race on the WAL switch itself
  // (it takes a write lock), and without a timeout the losers fail instantly
  // with SQLITE_BUSY. The timeout covers a CUMULATIVE wait, not one critical
  // section — the last worker queues behind every other one.
  db.pragma("busy_timeout = 30000");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  // Serialize the write side of startup across processes: `next build` collects
  // page data in several workers, each opening this file, and PRAGMA table_info
  // followed by ALTER TABLE is not atomic between them.
  db.exec("BEGIN IMMEDIATE");
  try {
    migrate(db);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return db;
}

function migrate(db: Database.Database) {
  db.exec(`
    -- Accounts are NOT owned here. Sign-in belongs to elite-v2 (see lib/sso.ts):
    -- this table is a local mirror of the accounts that have actually been seen,
    -- written on every successful verify. It exists because a clip, a like or a
    -- comment has to render a name and an avatar without a round trip, and
    -- because the id it stores is elite-v2's id — the same integer the migrated
    -- rows already carry. Nothing here is a credential.
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      email TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      username TEXT,
      display_name TEXT,
      avatar_url TEXT,
      synced_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Per-section capabilities an admin can grant an individual account.
    -- Admins hold every permission implicitly (no rows needed).
    CREATE TABLE IF NOT EXISTS user_permissions (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      permission TEXT NOT NULL,
      PRIMARY KEY (user_id, permission)
    );

    -- Short-video feed. The channel column survives the extraction from elite-v2
    -- so the schema, the storage keys and the maintenance scripts stay identical
    -- to the rows that were migrated in — but this app serves 'main' only. The
    -- 18+ channel stays behind in elite-v2 with its PIN gate.
    CREATE TABLE IF NOT EXISTS shorts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel TEXT NOT NULL DEFAULT 'main',
      category TEXT NOT NULL DEFAULT 'uncategorized',
      profile_id INTEGER REFERENCES short_profiles(id) ON DELETE SET NULL,
      uploader_id INTEGER REFERENCES users(id),
      caption TEXT,
      storage_key TEXT NOT NULL,
      poster_key TEXT,
      mime_type TEXT NOT NULL DEFAULT 'video/mp4',
      width INTEGER,
      height INTEGER,
      duration REAL,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'upload',
      source_id TEXT,
      status TEXT NOT NULL DEFAULT 'ready',
      -- 0 = public (everyone), 1 = private (only the uploader + admins).
      is_private INTEGER NOT NULL DEFAULT 0,
      is_deleted INTEGER NOT NULL DEFAULT 0,
      ai_summary TEXT,
      ai_summary_tags TEXT,
      ai_summary_model TEXT,
      ai_summary_at TEXT,
      ai_summary_error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_shorts_channel_created
      ON shorts(channel, is_deleted, created_at);
    CREATE INDEX IF NOT EXISTS idx_shorts_profile_source
      ON shorts(profile_id, source_id);
    CREATE INDEX IF NOT EXISTS idx_shorts_channel_category
      ON shorts(channel, category, is_deleted, status);

    CREATE TABLE IF NOT EXISTS short_likes (
      short_id INTEGER NOT NULL REFERENCES shorts(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (short_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS short_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      short_id INTEGER NOT NULL REFERENCES shorts(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_short_comments_short
      ON short_comments(short_id, created_at);

    -- Auto-poll source profiles. skipped_ids holds a JSON array of
    -- source-specific ids the poller should keep skipping.
    CREATE TABLE IF NOT EXISTS short_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      channel TEXT NOT NULL DEFAULT 'main',
      source_type TEXT NOT NULL DEFAULT 'yt-dlp',
      source_ref TEXT NOT NULL,
      auto_poll INTEGER NOT NULL DEFAULT 0,
      videos_limit INTEGER NOT NULL DEFAULT 20,
      skipped_ids TEXT NOT NULL DEFAULT '[]',
      last_polled_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Linked aliases: when several handles for the same creator are merged into
    -- one profile, each merged-away name maps to the survivor so a later import
    -- of that handle reuses it instead of recreating a duplicate. Lowercase.
    CREATE TABLE IF NOT EXISTS short_profile_aliases (
      channel TEXT NOT NULL,
      name TEXT NOT NULL,
      profile_id INTEGER NOT NULL REFERENCES short_profiles(id) ON DELETE CASCADE,
      PRIMARY KEY (channel, name)
    );

    -- Following. In elite-v2 a follow could point at a user, a post creator or a
    -- shorts profile, and the feed had to resolve all three through the unified
    -- person graph. Here there are only two kinds of face, so the graph collapses
    -- to this table and the Following feed is a plain join.
    CREATE TABLE IF NOT EXISTS follows (
      follower_id INTEGER NOT NULL,
      target_type TEXT NOT NULL CHECK (target_type IN ('user','shorts')),
      target_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (follower_id, target_type, target_id)
    );

    CREATE TABLE IF NOT EXISTS short_playlists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS short_playlist_items (
      playlist_id INTEGER NOT NULL REFERENCES short_playlists(id) ON DELETE CASCADE,
      short_id INTEGER NOT NULL REFERENCES shorts(id) ON DELETE CASCADE,
      added_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (playlist_id, short_id)
    );

    -- Duplicate-scan results, rewritten on every scan. Reported for review —
    -- nothing is deleted automatically.
    CREATE TABLE IF NOT EXISTS short_dupe_groups (
      group_key TEXT NOT NULL,
      short_id INTEGER NOT NULL REFERENCES shorts(id) ON DELETE CASCADE,
      channel TEXT NOT NULL,
      match_type TEXT NOT NULL,
      quality_score REAL NOT NULL DEFAULT 0,
      is_best INTEGER NOT NULL DEFAULT 0,
      scanned_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (group_key, short_id)
    );

    CREATE INDEX IF NOT EXISTS idx_short_dupe_short
      ON short_dupe_groups(short_id);

    CREATE TABLE IF NOT EXISTS short_dupe_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      status TEXT NOT NULL DEFAULT 'idle',
      started_at TEXT,
      finished_at TEXT,
      scanned INTEGER NOT NULL DEFAULT 0,
      groups INTEGER NOT NULL DEFAULT 0,
      message TEXT
    );

    -- Per-clip fingerprint cache (sha256 + JSON array of frame hashes) so repeat
    -- scans skip clips whose file size is unchanged.
    CREATE TABLE IF NOT EXISTS short_media_fp (
      short_id INTEGER PRIMARY KEY REFERENCES shorts(id) ON DELETE CASCADE,
      size_bytes INTEGER NOT NULL,
      sha TEXT,
      sig TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Pairs a person has reviewed and called "not duplicates". The scanner reads
    -- this and leaves them ungrouped, so dismissing a group makes it stay gone —
    -- in elite-v2 the same button wrote to a table nothing consulted, and the
    -- group came back on the next run. Lower id first, so a pair has exactly one
    -- representation.
    CREATE TABLE IF NOT EXISTS short_dupe_dismissals (
      a_id INTEGER NOT NULL,
      b_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (a_id, b_id)
    );

    -- Single-row progress beacons, so the admin page can poll while a detached
    -- script runs.
    CREATE TABLE IF NOT EXISTS short_title_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      status TEXT NOT NULL DEFAULT 'idle',
      started_at TEXT,
      finished_at TEXT,
      processed INTEGER NOT NULL DEFAULT 0,
      updated INTEGER NOT NULL DEFAULT 0,
      total INTEGER NOT NULL DEFAULT 0,
      message TEXT
    );

    CREATE TABLE IF NOT EXISTS short_caption_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      status TEXT NOT NULL DEFAULT 'idle',
      started_at TEXT,
      finished_at TEXT,
      processed INTEGER NOT NULL DEFAULT 0,
      updated INTEGER NOT NULL DEFAULT 0,
      total INTEGER NOT NULL DEFAULT 0,
      message TEXT
    );
  `);

  // Full-text index over captions, as a content table over `shorts` so the index
  // holds no copy of the text. Guarded: a build of SQLite without FTS5 falls
  // back to LIKE rather than failing to start.
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS shorts_fts
        USING fts5(caption, content='shorts', content_rowid='id');
      CREATE TRIGGER IF NOT EXISTS shorts_fts_ai AFTER INSERT ON shorts BEGIN
        INSERT INTO shorts_fts(rowid, caption) VALUES (new.id, new.caption);
      END;
      CREATE TRIGGER IF NOT EXISTS shorts_fts_ad AFTER DELETE ON shorts BEGIN
        INSERT INTO shorts_fts(shorts_fts, rowid, caption) VALUES('delete', old.id, old.caption);
      END;
      CREATE TRIGGER IF NOT EXISTS shorts_fts_au AFTER UPDATE ON shorts BEGIN
        INSERT INTO shorts_fts(shorts_fts, rowid, caption) VALUES('delete', old.id, old.caption);
        INSERT INTO shorts_fts(rowid, caption) VALUES (new.id, new.caption);
      END;
    `);
    // The triggers only see rows written after the index existed, so a database
    // seeded by the migration script (which copies rows in with the triggers
    // already present is fine, but a restore is not) would have an index that
    // silently misses everything older. Rebuild once when the two disagree.
    const indexed = (
      db.prepare("SELECT COUNT(*) AS c FROM shorts_fts").get() as { c: number }
    ).c;
    const rows = (
      db.prepare("SELECT COUNT(*) AS c FROM shorts").get() as { c: number }
    ).c;
    if (indexed !== rows) {
      db.exec("INSERT INTO shorts_fts(shorts_fts) VALUES('rebuild')");
    }
  } catch {
    /* FTS5 unavailable — search uses a LIKE fallback */
  }

  // Guarded ALTERs for databases created by an earlier version of this file.
  // PRAGMA table_info + ALTER is not atomic across processes, so the
  // "duplicate column name" a losing build worker sees is swallowed.
  const shortColumns = (
    db.prepare("PRAGMA table_info(shorts)").all() as { name: string }[]
  ).map((c) => c.name);
  for (const [name, type] of [
    ["ai_summary", "TEXT"],
    ["ai_summary_tags", "TEXT"],
    ["ai_summary_model", "TEXT"],
    ["ai_summary_at", "TEXT"],
    ["ai_summary_error", "TEXT"],
  ] as const) {
    if (!shortColumns.includes(name)) {
      try {
        db.exec(`ALTER TABLE shorts ADD COLUMN ${name} ${type}`);
      } catch (e) {
        if (!String(e).includes("duplicate column name")) throw e;
      }
    }
  }

  // Both beacons are single-row by construction; create the row up front so
  // every reader can UPDATE instead of having to UPSERT.
  db.exec(`
    INSERT OR IGNORE INTO short_dupe_state (id) VALUES (1);
    INSERT OR IGNORE INTO short_title_state (id) VALUES (1);
    INSERT OR IGNORE INTO short_caption_state (id) VALUES (1);
  `);
}

export const db = globalForDb.db ?? createDb();
if (process.env.NODE_ENV !== "production") globalForDb.db = db;

// --- Row types ---

// Kept as a union even though this app only ever writes 'main': the column is
// still in the schema, the migrated rows carry it, and the storage keys and
// scripts resolve paths through it.
export type ShortChannel = "main" | "18plus";

export type ShortCategory =
  | "straight"
  | "gay"
  | "lesbian"
  | "trans"
  | "solo"
  | "uncategorized";

export interface UserRow {
  id: number;
  email: string;
  role: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
  synced_at: string;
}

export interface ShortRow {
  id: number;
  channel: ShortChannel;
  category: ShortCategory;
  profile_id: number | null;
  uploader_id: number | null;
  caption: string | null;
  storage_key: string;
  poster_key: string | null;
  mime_type: string;
  width: number | null;
  height: number | null;
  duration: number | null;
  size_bytes: number;
  source: "upload" | "poll" | "import";
  source_id: string | null;
  status: "ready" | "pending" | "failed";
  is_private: number;
  is_deleted: number;
  ai_summary: string | null;
  ai_summary_tags: string | null;
  ai_summary_model: string | null;
  ai_summary_at: string | null;
  ai_summary_error: string | null;
  created_at: string;
}

export interface ShortLikeRow {
  short_id: number;
  user_id: number;
  created_at: string;
}

export interface ShortCommentRow {
  id: number;
  short_id: number;
  user_id: number;
  body: string;
  created_at: string;
}

export interface ShortProfileRow {
  id: number;
  name: string;
  channel: ShortChannel;
  // 'manual' profiles have no poll source (source_ref empty); clips arrive from
  // the import folder or an upload instead.
  source_type: "yt-dlp" | "rss" | "manual";
  source_ref: string;
  auto_poll: number;
  videos_limit: number;
  skipped_ids: string;
  last_polled_at: string | null;
  created_at: string;
}

export interface ShortProfileAliasRow {
  channel: ShortChannel;
  name: string;
  profile_id: number;
}

export interface FollowRow {
  follower_id: number;
  target_type: "user" | "shorts";
  target_id: number;
  created_at: string;
}

export interface ShortPlaylistRow {
  id: number;
  user_id: number;
  name: string;
  created_at: string;
}

export interface ShortPlaylistItemRow {
  playlist_id: number;
  short_id: number;
  added_at: string;
}

export interface ShortDupeGroupRow {
  group_key: string;
  short_id: number;
  channel: ShortChannel;
  match_type: "exact" | "perceptual";
  quality_score: number;
  is_best: number;
  scanned_at: string;
}

export interface ShortDupeStateRow {
  id: number;
  status: "idle" | "running" | "done" | "error";
  started_at: string | null;
  finished_at: string | null;
  scanned: number;
  groups: number;
  message: string | null;
}

export interface ShortTitleStateRow {
  id: number;
  status: "idle" | "running" | "done" | "error";
  started_at: string | null;
  finished_at: string | null;
  processed: number;
  updated: number;
  total: number;
  message: string | null;
}

// Same shape, different job: the caption backfill.
export type ShortCaptionStateRow = ShortTitleStateRow;

export interface MediaFpRow {
  short_id: number;
  size_bytes: number;
  sha: string | null;
  sig: string | null;
  updated_at: string;
}

export interface ShortDupeDismissalRow {
  a_id: number;
  b_id: number;
  created_at: string;
}

export interface UserPermissionRow {
  user_id: number;
  permission: string;
}
