#!/usr/bin/env node
// One-off: seed this app's database from elite-v2's, taking the main channel and
// leaving the 18+ library where it is.
//
//   node scripts/migrate-from-elitev2.mjs <source.db> [dest.db]
//
// The source MUST be a snapshot taken with SQLite's .backup, not a copied file:
// elite-v2 runs in WAL mode, and a plain `cp` of the .db without its -wal is a
// file that opens fine and reports zero rows.
//
// Ids are preserved. That is the whole point — a clip's storage_key, a like's
// user_id and a playlist's contents all reference ids that exist on the other
// side, and renumbering would mean rewriting every one of them. The accounts
// come across as a mirror of elite-v2's users + user_profiles, keyed by the same
// integer the session already carries (lib/sso.ts).
//
// Idempotent: every insert is INSERT OR IGNORE, so a re-run adds what is missing
// and touches nothing that is already here. It does NOT delete: a row removed in
// elite-v2 after the first run stays here, because by then this app is the owner
// of its own library and a second migration is a top-up, not a mirror.

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const SRC = process.argv[2];
const DEST =
  process.argv[3] ||
  path.join(process.env.DATA_DIR || "/app/data", "tikshortis.db");
const CHANNEL = "main";

const log = (m) => console.log(`[migrate] ${m}`);

if (!SRC || !fs.existsSync(SRC)) {
  console.error("usage: migrate-from-elitev2.mjs <source.db> [dest.db]");
  process.exit(1);
}

const db = new Database(DEST);
db.pragma("busy_timeout = 30000");
db.pragma("journal_mode = WAL");

// The destination schema is created by the app on first start. Running this
// before that has happened would build half a schema here and let the app's own
// migrate() disagree with it later, so refuse rather than guess.
const haveShorts = db
  .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='shorts'")
  .get();
if (!haveShorts) {
  console.error(
    "The destination has no schema yet. Start the app once (it runs migrate() " +
      "on boot), then run this."
  );
  process.exit(1);
}

db.prepare("ATTACH DATABASE ? AS src").run(SRC);

// Foreign keys are enforced in the app; here the copy order is what guarantees
// them (profiles before clips, clips before likes), and turning the check off
// would only hide a real ordering mistake.
db.pragma("foreign_keys = ON");

const counts = {};
function copy(label, sql, params = {}) {
  const info = db.prepare(sql).run(params);
  counts[label] = info.changes;
  log(`${label}: ${info.changes}`);
}

const tx = db.transaction(() => {
  // Accounts first: everything else references them. elite-v2 keeps the handle
  // and display name in user_profiles, one row per user, so the two are folded
  // into the single mirror table this app has. The avatar is deliberately not
  // copied — it is a storage key in elite-v2's tree, meaningless here; the
  // session brings a URL instead.
  copy(
    "users",
    `INSERT OR IGNORE INTO main.users (id, email, role, username, display_name)
     SELECT u.id, u.email, u.role, p.username, p.display_name
       FROM src.users u
       LEFT JOIN src.user_profiles p ON p.user_id = u.id`
  );

  copy(
    "short_profiles",
    `INSERT OR IGNORE INTO main.short_profiles
       (id, name, channel, source_type, source_ref, auto_poll, videos_limit,
        skipped_ids, last_polled_at, created_at)
     SELECT id, name, channel, source_type, source_ref, auto_poll, videos_limit,
            skipped_ids, last_polled_at, created_at
       FROM src.short_profiles WHERE channel = @channel`,
    { channel: CHANNEL }
  );

  copy(
    "short_profile_aliases",
    `INSERT OR IGNORE INTO main.short_profile_aliases (channel, name, profile_id)
     SELECT channel, name, profile_id
       FROM src.short_profile_aliases WHERE channel = @channel`,
    { channel: CHANNEL }
  );

  // Soft-deleted clips come too. They are rows the maintenance sweep and the
  // duplicate report still reason about, and dropping them would silently
  // resurrect files on disk that someone had already decided against.
  copy(
    "shorts",
    `INSERT OR IGNORE INTO main.shorts
       (id, channel, category, profile_id, uploader_id, caption, storage_key,
        poster_key, mime_type, width, height, duration, size_bytes, source,
        source_id, status, is_private, is_deleted, ai_summary, ai_summary_tags,
        ai_summary_model, ai_summary_at, ai_summary_error, created_at)
     SELECT id, channel, category, profile_id, uploader_id, caption, storage_key,
            poster_key, mime_type, width, height, duration, size_bytes, source,
            source_id, status, is_private, is_deleted, ai_summary, ai_summary_tags,
            ai_summary_model, ai_summary_at, ai_summary_error, created_at
       FROM src.shorts WHERE channel = @channel`,
    { channel: CHANNEL }
  );

  copy(
    "short_likes",
    `INSERT OR IGNORE INTO main.short_likes (short_id, user_id, created_at)
     SELECT l.short_id, l.user_id, l.created_at
       FROM src.short_likes l
       JOIN main.shorts s ON s.id = l.short_id`
  );

  copy(
    "short_comments",
    `INSERT OR IGNORE INTO main.short_comments (id, short_id, user_id, body, created_at)
     SELECT c.id, c.short_id, c.user_id, c.body, c.created_at
       FROM src.short_comments c
       JOIN main.shorts s ON s.id = c.short_id`
  );

  // A playlist in elite-v2 could hold clips from both channels. Only the ones
  // whose clips landed here come across; a playlist that turns out to be empty
  // afterwards was an 18+ playlist and is left behind with its clips.
  copy(
    "short_playlists",
    `INSERT OR IGNORE INTO main.short_playlists (id, user_id, name, created_at)
     SELECT DISTINCT p.id, p.user_id, p.name, p.created_at
       FROM src.short_playlists p
       JOIN src.short_playlist_items i ON i.playlist_id = p.id
       JOIN main.shorts s ON s.id = i.short_id`
  );

  copy(
    "short_playlist_items",
    `INSERT OR IGNORE INTO main.short_playlist_items (playlist_id, short_id, added_at)
     SELECT i.playlist_id, i.short_id, i.added_at
       FROM src.short_playlist_items i
       JOIN main.short_playlists p ON p.id = i.playlist_id
       JOIN main.shorts s ON s.id = i.short_id`
  );

  // The fingerprint cache is what makes the first duplicate scan here cheap
  // instead of a full re-hash of 19 GB.
  copy(
    "short_media_fp",
    `INSERT OR IGNORE INTO main.short_media_fp (short_id, size_bytes, sha, sig, updated_at)
     SELECT f.short_id, f.size_bytes, f.sha, f.sig, f.updated_at
       FROM src.short_media_fp f
       JOIN main.shorts s ON s.id = f.short_id`
  );

  copy(
    "short_dupe_groups",
    `INSERT OR IGNORE INTO main.short_dupe_groups
       (group_key, short_id, channel, match_type, quality_score, is_best, scanned_at)
     SELECT g.group_key, g.short_id, g.channel, g.match_type, g.quality_score,
            g.is_best, g.scanned_at
       FROM src.short_dupe_groups g
       JOIN main.shorts s ON s.id = g.short_id
      WHERE g.channel = @channel`,
    { channel: CHANNEL }
  );

  // Follows: elite-v2 recorded three kinds of target and only two exist here.
  // A 'creator' follow points at a post_creators row — a face from a module that
  // did not come along — so it is resolved to the shorts profile of the same
  // handle where there is one, and dropped where there is not. Silently keeping
  // it as an id would make it point at an unrelated profile.
  copy(
    "follows (shorts)",
    `INSERT OR IGNORE INTO main.follows (follower_id, target_type, target_id, created_at)
     SELECT f.follower_id, 'shorts', f.target_id, f.created_at
       FROM src.follows f
       JOIN main.short_profiles p ON p.id = f.target_id
      WHERE f.target_type = 'shorts'`
  );
  copy(
    "follows (users)",
    `INSERT OR IGNORE INTO main.follows (follower_id, target_type, target_id, created_at)
     SELECT f.follower_id, 'user', f.target_id, f.created_at
       FROM src.follows f
       JOIN main.users u ON u.id = f.target_id
      WHERE f.target_type = 'user'`
  );
  copy(
    "follows (creator -> profile)",
    `INSERT OR IGNORE INTO main.follows (follower_id, target_type, target_id, created_at)
     SELECT f.follower_id, 'shorts', p.id, f.created_at
       FROM src.follows f
       JOIN src.post_creators c ON c.id = f.target_id
       JOIN main.short_profiles p ON lower(p.name) = lower(c.username)
      WHERE f.target_type = 'creator'`
  );
});

tx();

// The FTS index is a content table over `shorts`; its sync triggers only fire on
// writes made through them, and an INSERT ... SELECT into the table does fire
// them — but a re-run that inserts nothing leaves an index built during a
// previous partial run untouched. Rebuilding is cheap and always correct.
try {
  db.exec("INSERT INTO shorts_fts(shorts_fts) VALUES('rebuild')");
  log("shorts_fts: rebuilt");
} catch (err) {
  log(`shorts_fts: skipped (${err.message})`);
}

db.prepare("DETACH DATABASE src").run();

const total = db.prepare("SELECT COUNT(*) AS c FROM shorts").get().c;
const profiles = db.prepare("SELECT COUNT(*) AS c FROM short_profiles").get().c;
log(`done — ${total} clips, ${profiles} profiles in ${DEST}`);
console.log(`RESULT ${JSON.stringify(counts)}`);
