#!/usr/bin/env node
// Auto-poller. Runs INSIDE the tikshortis container via
// `docker exec` on a host systemd timer. For every short_profiles row with
// auto_poll=1 it fetches the latest clips from the source, downloads new ones
// into the channel folder as a `pending` short, and lets the v1b transcoder
// turn them into .web.mp4.
//
// Two source types:
//   - yt-dlp : source_ref is a channel/playlist URL (YouTube, TikTok, …);
//              entries are enumerated with `yt-dlp --flat-playlist`.
//   - rss    : source_ref is an RSS/Atom feed; <item> links/enclosures are the
//              candidates and still downloaded through yt-dlp (generic extractor).
//
// Dedup is by (profile_id, source_id): a clip already downloaded for the profile,
// or listed in the profile's sticky skipped_ids, is never fetched again.
// A lockfile guards against overlapping runs. Output goes to journald.
//
// The same run also keeps each profile's avatar fresh (see refreshAvatar):
//   node scripts/poll-shorts.mjs            timer: clips for auto_poll profiles,
//                                           plus a capped batch of stale avatars
//   node scripts/poll-shorts.mjs <id>       one profile now: avatar + clips
//   node scripts/poll-shorts.mjs --avatars  every stale avatar, no clip polling

import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const DATA_DIR = process.env.DATA_DIR || "/app/data";
const DB_PATH = path.join(DATA_DIR, "tikshortis.db");
const SHORTS_ROOT = process.env.SHORTS_ROOT || "/shorts-store";
const YT_DLP = process.env.YT_DLP_BIN || "yt-dlp";
const LOCK = "/tmp/tikshortis-poll.lock";

const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);

// --- Single-run lock -------------------------------------------------------
let lockFd;
try {
  lockFd = fs.openSync(LOCK, "wx");
  fs.writeSync(lockFd, String(process.pid));
} catch (err) {
  if (err.code === "EEXIST") {
    try {
      const pid = Number(fs.readFileSync(LOCK, "utf8").trim());
      process.kill(pid, 0);
      process.exit(0);
    } catch {
      fs.rmSync(LOCK, { force: true });
      lockFd = fs.openSync(LOCK, "wx");
      fs.writeSync(lockFd, String(process.pid));
    }
  } else {
    throw err;
  }
}
process.on("exit", () => {
  try {
    fs.closeSync(lockFd);
    fs.rmSync(LOCK, { force: true });
  } catch {
    /* best effort */
  }
});

// --- Helpers ---------------------------------------------------------------
function channelDir(channel) {
  return path.join(SHORTS_ROOT, channel === "18plus" ? "18plus" : "main");
}

// Per-profile subfolder, kept identical to lib/shorts-storage.ts profileSlug().
function profileSlug(name) {
  const slug = (name || "unknown")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 64);
  return slug || "unknown";
}

// Resolve (and create) the folder a profile's clips live in.
function profileDir(channel, name) {
  const dir = path.join(channelDir(channel), profileSlug(name));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function isHttp(u) {
  return typeof u === "string" && /^https?:\/\//i.test(u);
}

// Enumerate the latest candidate clips for a profile. Returns
// [{ id, title, url }] newest-first, capped to `limit`.
function enumerateCandidates(profile, limit) {
  if (profile.source_type === "rss") return enumerateRss(profile.source_ref, limit);
  return enumerateYtDlp(profile.source_ref, limit);
}

function enumerateYtDlp(ref, limit) {
  let out;
  try {
    out = execFileSync(
      YT_DLP,
      [
        "--flat-playlist",
        "--dump-json",
        "--playlist-end", String(limit),
        "--no-warnings",
        "--",
        ref,
      ],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 120_000 }
    );
  } catch (err) {
    // yt-dlp exits non-zero on partial failures but may still print usable
    // lines on stdout; fall back to whatever it produced.
    out = err.stdout ? String(err.stdout) : "";
    if (!out) throw err;
  }
  const items = [];
  for (const line of out.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const e = JSON.parse(t);
      const id = e.id ? String(e.id) : null;
      if (!id) continue;
      let url = isHttp(e.url) ? e.url : isHttp(e.webpage_url) ? e.webpage_url : null;
      // YouTube flat entries sometimes give only the bare id.
      if (!url && /youtube/i.test(e.ie_key || e.extractor || "")) {
        url = `https://www.youtube.com/watch?v=${id}`;
      }
      if (!url) continue;
      items.push({ id, title: e.title || null, url });
    } catch {
      /* skip unparseable line */
    }
  }
  return items.slice(0, limit);
}

async function enumerateRss(ref, limit) {
  const res = await fetch(ref, { headers: { "User-Agent": "tikshortis/1.0" } });
  if (!res.ok) throw new Error(`RSS fetch ${res.status}`);
  const xml = await res.text();
  const items = [];
  const blocks = xml.match(/<(item|entry)[\s\S]*?<\/(item|entry)>/gi) || [];
  for (const b of blocks) {
    const enclosure = b.match(/<enclosure[^>]*url=["']([^"']+)["']/i)?.[1];
    const link =
      b.match(/<link[^>]*href=["']([^"']+)["']/i)?.[1] || // Atom
      b.match(/<link>([\s\S]*?)<\/link>/i)?.[1]?.trim(); // RSS
    const url = isHttp(enclosure) ? enclosure : isHttp(link) ? link : null;
    if (!url) continue;
    const guid =
      b.match(/<guid[^>]*>([\s\S]*?)<\/guid>/i)?.[1]?.trim() || url;
    const title = b.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
      ?.replace(/<!\[CDATA\[|\]\]>/g, "")
      .trim();
    items.push({ id: guid, title: title || null, url });
    if (items.length >= limit) break;
  }
  return items;
}

// True when the file contains at least one video stream. TikTok photo posts
// (slideshows) expose only their mp3 music track to yt-dlp — those download
// "successfully" but are useless as shorts.
function hasVideoStream(filePath) {
  try {
    const out = execFileSync(
      "ffprobe",
      ["-v", "error", "-select_streams", "v", "-show_entries", "stream=codec_type",
       "-of", "csv=p=0", filePath],
      { encoding: "utf8", timeout: 60_000 }
    );
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

function download(url, dir, uuid) {
  execFileSync(
    YT_DLP,
    [
      "--no-playlist",
      // Merging selector (video+audio): plain "best" picks a single pre-muxed
      // stream and yields silent files for sources that only expose split streams.
      "-f", "bv*[height<=1920]+ba/b[height<=1920]/bv*+ba/b",
      // Prefer h264: TikTok's hevc (bytevc1) formats claim aac audio in metadata
      // but the actual streams are silent; h264 carries real audio and also
      // remuxes without a full transcode.
      "-S", "vcodec:h264",
      "--merge-output-format", "mp4",
      "-o", path.join(dir, `${uuid}.%(ext)s`),
      "--no-warnings", "--no-progress", "--quiet",
      "--",
      url,
    ],
    { stdio: "ignore", timeout: 5 * 60 * 1000 }
  );
  // Locate whatever extension yt-dlp produced.
  const produced = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(`${uuid}.`) && !f.endsWith(".part"));
  return produced.length ? produced[0] : null;
}

// Everything yt-dlp left behind for this uuid: a `.part`, a lone audio or
// video stream that never got merged, a `.ytdl` resume file. No row points at
// any of it, so it would sit in the profile folder forever.
function removeLeftovers(dir, uuid) {
  let names;
  try {
    names = fs.readdirSync(dir).filter((f) => f.startsWith(`${uuid}.`));
  } catch {
    return;
  }
  for (const f of names) fs.rmSync(path.join(dir, f), { force: true });
}

// --- Main ------------------------------------------------------------------
const db = new Database(DB_PATH);
// busy_timeout FIRST: the WAL switch itself takes a write lock, and a
// process that loses that race fails instantly with SQLITE_BUSY when no
// timeout is set yet.
db.pragma("busy_timeout = 10000"); // tolerate the app/transcoder writing too
db.pragma("journal_mode = WAL");

// Mirrored in lib/db.ts: the avatar columns, for a database the app has not
// migrated yet (the local test harness opens a bare scratch DB).
const profileColumns = db.prepare("PRAGMA table_info(short_profiles)").all().map((c) => c.name);
for (const [name, type] of [["avatar_key", "TEXT"], ["avatar_checked_at", "TEXT"]]) {
  if (!profileColumns.includes(name)) {
    try {
      db.exec(`ALTER TABLE short_profiles ADD COLUMN ${name} ${type}`);
    } catch (e) {
      if (!String(e).includes("duplicate column name")) throw e;
    }
  }
}

// --- Avatars -----------------------------------------------------------------
// The creator picture is re-checked this often. TikTok's avatar URLs are signed
// and expire within days, so the image is downloaded and kept, not linked.
const AVATAR_TTL_DAYS = 7;
// The timer run refreshes at most this many stale avatars per pass, so a
// backlog never turns one poll into a burst of profile-page fetches.
const AVATAR_BATCH = 20;
const AVATAR_SIZE = 512;
const AVATAR_FILE = "avatar.jpg";
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";

function isTikTok(ref) {
  try {
    const host = new URL(ref).hostname.toLowerCase();
    return host === "tiktok.com" || host.endsWith(".tiktok.com");
  } catch {
    return false;
  }
}

// TikTok's profile page embeds the user record as JSON in a <script> tag;
// yt-dlp's tiktok:user extractor exposes no avatar at all, so the page itself
// is the only source. The value is JSON-escaped ("\u002F" for "/").
async function tiktokAvatarUrl(ref) {
  const res = await fetch(ref, {
    headers: { "User-Agent": BROWSER_UA, "Accept-Language": "en-US,en;q=0.9" },
    redirect: "follow",
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`profile page ${res.status}`);
  const html = await res.text();
  const m =
    html.match(/"avatarLarger":"([^"]+)"/) ||
    html.match(/"avatarMedium":"([^"]+)"/) ||
    html.match(/"avatarThumb":"([^"]+)"/);
  if (!m) throw new Error("no avatar in profile page");
  const url = JSON.parse(`"${m[1]}"`);
  if (!isHttp(url)) throw new Error("avatar url is not http(s)");
  return url;
}

// Other yt-dlp sources (a YouTube channel, for one) carry the channel picture
// as the playlist's own thumbnails; take the largest one.
function ytDlpAvatarUrl(ref) {
  const out = execFileSync(
    YT_DLP,
    ["--flat-playlist", "--playlist-end", "1", "--dump-single-json", "--no-warnings", "--", ref],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 60_000 }
  );
  const j = JSON.parse(out);
  const thumbs = Array.isArray(j.thumbnails) ? j.thumbnails.filter((t) => isHttp(t?.url)) : [];
  if (thumbs.length === 0) throw new Error("no playlist thumbnails");
  thumbs.sort((a, b) => (b.width || 0) - (a.width || 0));
  return thumbs[0].url;
}

// True for the byte signatures sharp can decode here. A login wall or an error
// page arrives as HTTP 200 HTML, so the content is checked, not the headers.
function looksLikeImage(buf) {
  if (buf.length < 12) return false;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true; // JPEG
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return true; // PNG
  if (buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP")
    return true; // WebP
  return false;
}

async function downloadAvatar(url, dest) {
  const res = await fetch(url, {
    headers: { "User-Agent": BROWSER_UA },
    redirect: "follow",
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`avatar fetch ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!looksLikeImage(buf)) throw new Error("avatar is not an image");
  const jpeg = await sharp(buf)
    .rotate()
    .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: "cover" })
    .jpeg({ quality: 85 })
    .toBuffer();
  // Write beside, then rename: a reader never sees a half-written file, and a
  // failure leaves the previous avatar in place.
  const tmp = `${dest}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, jpeg);
  fs.renameSync(tmp, dest);
}

const markAvatar = db.prepare(
  "UPDATE short_profiles SET avatar_key = ?, avatar_checked_at = datetime('now') WHERE id = ?"
);

// Fetch (or re-fetch) one profile's picture. Every outcome stamps
// avatar_checked_at so a source with no picture is retried on the TTL, not on
// every run; a failure keeps whatever avatar_key was there before.
async function refreshAvatar(profile) {
  if (profile.source_type === "manual" || !isHttp(profile.source_ref)) return;
  const key = `${profileSlug(profile.name)}/${AVATAR_FILE}`;
  try {
    const url = isTikTok(profile.source_ref)
      ? await tiktokAvatarUrl(profile.source_ref)
      : ytDlpAvatarUrl(profile.source_ref);
    // The folder is created only once there is something to put in it, so a
    // source without a picture leaves no empty profile directory behind.
    const dir = profileDir(profile.channel, profile.name);
    await downloadAvatar(url, path.join(dir, AVATAR_FILE));
    markAvatar.run(key, profile.id);
    log(`profile ${profile.id} (${profile.name}): avatar updated`);
  } catch (err) {
    markAvatar.run(profile.avatar_key ?? null, profile.id);
    log(`profile ${profile.id} (${profile.name}): avatar failed: ${String(err.message).slice(0, 120)}`);
  }
}

// A source id that keeps failing (removed clip, geo-blocked, an extractor
// yt-dlp no longer handles) was re-downloaded on every run forever. After this
// many failed runs it joins skipped_ids like a photo post does. A run that
// succeeds clears the counter, so a transient outage never gets a clip skipped.
const MAX_DOWNLOAD_FAILURES = 3;

// Mirrored in lib/db.ts. One row per (profile, source id) that failed to
// download; deleted on success or when the id is moved to skipped_ids.
db.exec(`
  CREATE TABLE IF NOT EXISTS short_poll_failures (
    profile_id INTEGER NOT NULL REFERENCES short_profiles(id) ON DELETE CASCADE,
    source_id TEXT NOT NULL,
    failures INTEGER NOT NULL DEFAULT 1,
    last_error TEXT,
    last_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (profile_id, source_id)
  );
`);
const bumpFailure = db.prepare(
  `INSERT INTO short_poll_failures (profile_id, source_id, failures, last_error, last_at)
   VALUES (?, ?, 1, ?, datetime('now'))
   ON CONFLICT(profile_id, source_id) DO UPDATE SET
     failures = failures + 1, last_error = excluded.last_error, last_at = excluded.last_at
   RETURNING failures`
);
const clearFailure = db.prepare(
  "DELETE FROM short_poll_failures WHERE profile_id = ? AND source_id = ?"
);

// With a profile id argument, poll just that profile on demand (ignores the
// auto_poll flag) — used by the "Poll now" button and on profile create.
// Without one, poll every profile with auto_poll enabled (the timer path).
// `--avatars` refreshes every stale avatar and polls no clips (backfill).
const args = process.argv.slice(2);
const avatarsOnly = args.includes("--avatars");
const idArg = args.find((a) => /^\d+$/.test(a));
const argId = idArg ? Number(idArg) : null;
const profiles = argId
  ? db.prepare("SELECT * FROM short_profiles WHERE id = ?").all(argId)
  : avatarsOnly
    ? []
    : db.prepare("SELECT * FROM short_profiles WHERE auto_poll = 1").all();

// Stale = never checked, or checked more than AVATAR_TTL_DAYS ago. The on-demand
// path (an id) always refreshes; the timer path takes a capped batch across
// ALL sourced profiles, auto_poll or not, so a paused profile keeps its face.
const staleAvatars = argId
  ? profiles
  : db
      .prepare(
        `SELECT * FROM short_profiles
          WHERE source_type != 'manual' AND source_ref != ''
            AND (avatar_checked_at IS NULL
                 OR avatar_checked_at < datetime('now', ?))
          ORDER BY avatar_checked_at IS NOT NULL, avatar_checked_at, id
          LIMIT ?`
      )
      .all(`-${AVATAR_TTL_DAYS} days`, avatarsOnly ? 100000 : AVATAR_BATCH);
for (const profile of staleAvatars) await refreshAvatar(profile);

let totalNew = 0;

for (const profile of profiles) {
  const limit = Math.max(1, Math.min(profile.videos_limit || 20, 100));
  let skipped = [];
  try {
    skipped = JSON.parse(profile.skipped_ids || "[]");
  } catch {
    skipped = [];
  }
  const seen = new Set(
    db
      .prepare(
        "SELECT source_id FROM shorts WHERE profile_id = ? AND source_id IS NOT NULL"
      )
      .all(profile.id)
      .map((r) => r.source_id)
  );
  for (const s of skipped) seen.add(String(s));

  let candidates;
  try {
    candidates = await enumerateCandidates(profile, limit);
  } catch (err) {
    log(`profile ${profile.id} (${profile.name}): enumerate failed: ${err.message}`);
    continue;
  }

  const fresh = candidates.filter((c) => !seen.has(String(c.id)));
  if (fresh.length === 0) {
    db.prepare("UPDATE short_profiles SET last_polled_at = datetime('now') WHERE id = ?").run(
      profile.id
    );
    continue;
  }

  log(`profile ${profile.id} (${profile.name}): ${fresh.length} new of ${candidates.length}`);
  const slug = profileSlug(profile.name);
  const dir = profileDir(profile.channel, profile.name);

  const insert = db.prepare(
    `INSERT INTO shorts
       (channel, profile_id, uploader_id, caption, storage_key, poster_key,
        mime_type, source, source_id, status)
     VALUES (?, ?, NULL, ?, ?, NULL, 'video/mp4', 'poll', ?, 'pending')`
  );

  const newSkips = [];
  for (const c of fresh) {
    const uuid = randomUUID();
    try {
      const file = download(c.url, dir, uuid);
      if (!file) throw new Error("no file produced");
      // Photo/slideshow post (audio only): drop the file and remember the id
      // in skipped_ids so it's never fetched again.
      const filePath = path.join(dir, file);
      if (!hasVideoStream(filePath)) {
        fs.rmSync(filePath, { force: true });
        newSkips.push(String(c.id));
        log(`  - ${c.id} is a photo post (no video stream) — skipped permanently`);
        continue;
      }
      // storage_key is relative to the channel dir and includes the profile
      // subfolder, so the transcoder + media routes resolve it unchanged.
      const storageKey = `${slug}/${file}`;
      insert.run(profile.channel, profile.id, c.title, storageKey, String(c.id));
      clearFailure.run(profile.id, String(c.id));
      totalNew++;
      log(`  + ${c.id} -> ${storageKey}`);
    } catch (err) {
      removeLeftovers(dir, uuid);
      const message = String(err.message).slice(0, 120);
      const { failures } = bumpFailure.get(profile.id, String(c.id), message);
      if (failures >= MAX_DOWNLOAD_FAILURES) {
        newSkips.push(String(c.id));
        clearFailure.run(profile.id, String(c.id));
        log(`  ! ${c.id} download failed ${failures} times (${message}) — skipped permanently`);
      } else {
        log(`  ! ${c.id} download failed (${failures}/${MAX_DOWNLOAD_FAILURES}): ${message}`);
      }
    }
  }
  if (newSkips.length > 0) {
    db.prepare("UPDATE short_profiles SET skipped_ids = ? WHERE id = ?").run(
      JSON.stringify([...skipped.map(String), ...newSkips]),
      profile.id
    );
  }

  db.prepare("UPDATE short_profiles SET last_polled_at = datetime('now') WHERE id = ?").run(
    profile.id
  );
}

if (totalNew > 0) log(`poll complete: ${totalNew} new clip(s) queued for transcode`);
db.close();
