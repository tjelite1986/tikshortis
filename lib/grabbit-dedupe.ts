import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";

/**
 * Grabbit dedupe v1: TikShortis' side of Grabbit's Smart Duplicate Manager.
 *
 * Grabbit reads this library (read-only) and finds clips whose files have the
 * same bytes: the same video imported twice as two posts. Grabbit may not
 * touch these files, so it asks this app, and the app does it itself:
 *
 *   link    Both posts stay, each with its own caption, likes, comments,
 *           playlists and views. The extra file becomes a hard link to the
 *           kept one, so the bytes are stored once. The original extra file
 *           is held in .grabbit-dedupe-trash (same disk) until Grabbit's
 *           owner empties the trash; restore puts it back.
 *   restore Undo a link.
 *   purge   Delete a held original for good.
 *   lookup  Which posts use a file (for the review screen).
 *
 * No row changes: storage_key and poster_key keep pointing at the same names.
 * Every step on a name is atomic (link to a temp name, rename over), so the
 * hourly orphan sweep never sees a clip without its file. A clip later
 * deleted, moved or re-transcoded acts on its own name only; the other post
 * keeps its file.
 *
 * Auth: X-Grabbit-Dedupe-Token, compared in constant time with the secret in
 * GRABBIT_DEDUPE_TOKEN_FILE, read on every check. Unset, missing, unreadable
 * or shorter than 32 characters = every route refuses.
 */

export const TRASH_DIR = ".grabbit-dedupe-trash";
const CHANNELS = ["main", "18plus"] as const;
type Channel = (typeof CHANNELS)[number];

export class DedupeError extends Error {
  status: number;
  fix: string | null;
  constructor(message: string, status = 409, fix: string | null = null) {
    super(message);
    this.status = status;
    this.fix = fix;
  }
}

export function expectedToken(): string | null {
  // The mounted file is the only source, the same one Grabbit reads. It is
  // read on every check, so a rotated or removed token takes effect at once;
  // a missing or unreadable file switches the routes off.
  let value: string | null = null;
  const file = process.env.GRABBIT_DEDUPE_TOKEN_FILE;
  if (file) {
    try {
      value = fs.readFileSync(file, "utf8").trim() || null;
    } catch {
      value = null;
    }
  }
  if (value && value.length < 32) value = null;
  return value;
}

export function tokenOk(given: string | null): boolean {
  const expected = expectedToken();
  if (!expected || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export interface Ctx {
  db: Database.Database;
  shortsRoot: string;
  now?: () => number;
}

function ensureJournal(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS grabbit_dedupe_journal (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel TEXT NOT NULL,
    keep_key TEXT NOT NULL,
    drop_key TEXT NOT NULL,
    role TEXT NOT NULL,
    trash_name TEXT,
    sha256 TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'linked', 'restored', 'purged', 'failed')),
    error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    done_at TEXT
  )`);
}

// "main/creator/clip.web.mp4" -> channel main, key "creator/clip.web.mp4".
// Only files under SHORTS_ROOT/<channel>/, never the trash, never "..".
export function parsePath(ctx: Ctx, appPath: unknown): { channel: Channel; key: string; abs: string; dir: string } {
  if (typeof appPath !== "string" || !appPath || appPath.length > 1024 || appPath.includes("\0")) {
    throw new DedupeError("Not a library path", 400);
  }
  const norm = appPath.split("\\").join("/");
  const segs = norm.split("/");
  const channel = segs[0] as Channel;
  if (!CHANNELS.includes(channel) || segs.length < 2) throw new DedupeError("Not a library path", 400);
  if (segs.some((s) => s === "" || s === "." || s === ".." || s === TRASH_DIR)) throw new DedupeError("Not a library path", 400);
  const key = segs.slice(1).join("/");
  const dir = path.join(ctx.shortsRoot, channel);
  const abs = path.resolve(dir, key);
  if (!abs.startsWith(path.resolve(dir) + path.sep)) throw new DedupeError("Not a library path", 400);
  return { channel, key, abs, dir };
}

// The file itself, refusing symlinks anywhere on the way.
function regular(abs: string, dir: string): fs.Stats {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(abs);
  } catch {
    throw new DedupeError("The file is not there any more; Grabbit will see that on its next scan");
  }
  if (!st.isFile()) throw new DedupeError("Not a regular file");
  const real = fs.realpathSync(abs);
  if (real !== path.join(fs.realpathSync(dir), path.relative(dir, abs))) throw new DedupeError("The path runs through a link");
  return st;
}

function sha256Of(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    fs.createReadStream(file).on("error", reject).on("data", (c) => h.update(c)).on("end", () => resolve(h.digest("hex")));
  });
}

interface RefRow {
  id: number;
  channel: string;
  caption: string | null;
  profile: string | null;
  created_at: string;
  is_private: number;
  role: "video" | "poster";
  likes: number;
  comments: number;
}

function refsOf(db: Database.Database, channel: Channel, key: string): RefRow[] {
  return db
    .prepare(
      `SELECT s.id, s.channel, s.caption, p.name AS profile, s.created_at, s.is_private,
              CASE WHEN s.storage_key = @key THEN 'video' ELSE 'poster' END AS role,
              (SELECT COUNT(*) FROM short_likes l WHERE l.short_id = s.id) AS likes,
              (SELECT COUNT(*) FROM short_comments c WHERE c.short_id = s.id) AS comments
         FROM shorts s LEFT JOIN short_profiles p ON p.id = s.profile_id
        WHERE s.is_deleted = 0 AND s.channel = @channel AND (s.storage_key = @key OR s.poster_key = @key)
        ORDER BY s.id`
    )
    .all({ channel, key }) as RefRow[];
}

export function lookup(ctx: Ctx, paths: unknown) {
  if (!Array.isArray(paths) || paths.length > 500) throw new DedupeError("paths must be a list of at most 500", 400);
  return paths.map((p) => {
    const t = parsePath(ctx, p);
    let st: fs.Stats | null = null;
    try {
      st = fs.lstatSync(t.abs);
    } catch {
      st = null;
    }
    const refs = refsOf(ctx.db, t.channel, t.key);
    return {
      path: p,
      role: refs.length ? refs[0].role : "none",
      nlink: st ? st.nlink : 0,
      ino: st ? String(st.ino) : null,
      refs: refs.map((r) => ({
        type: r.role === "video" ? "clip" : "poster of clip",
        id: r.id,
        label: [r.profile ? `@${r.profile}` : null, r.caption ? r.caption.slice(0, 60) : null].filter(Boolean).join(" ") || `#${r.id}`,
        likes: r.likes,
        comments: r.comments,
        private: Boolean(r.is_private),
      })),
    };
  });
}

let busy = false;

export async function link(ctx: Ctx, body: { keep?: unknown; drop?: unknown; sha256?: unknown }) {
  ensureJournal(ctx.db);
  const keep = parsePath(ctx, body.keep);
  const drop = parsePath(ctx, body.drop);
  const sha = typeof body.sha256 === "string" && /^[0-9a-f]{64}$/.test(body.sha256) ? body.sha256 : null;
  if (!sha) throw new DedupeError("sha256 is required", 400);
  if (keep.channel !== drop.channel) throw new DedupeError("The clips are in different sections (main and 18+); they never share a file");
  if (keep.abs === drop.abs) throw new DedupeError("Choose two different files");
  const keepRefs = refsOf(ctx.db, keep.channel, keep.key);
  const dropRefs = refsOf(ctx.db, drop.channel, drop.key);
  if (!dropRefs.length) throw new DedupeError("No clip uses this file, so TikShortis does not merge it", 409, "Delete it in TikShortis' maintenance page if it is a leftover.");
  if (!keepRefs.length) throw new DedupeError("No clip uses the file to keep; choose another to keep");
  if (new Set(dropRefs.map((r) => r.role)).size > 1 || dropRefs[0].role !== keepRefs[0].role) {
    throw new DedupeError("A video and a poster frame are never merged");
  }
  if (busy) throw new DedupeError("Another merge is running; try again in a moment");
  busy = true;
  try {
    const ks = regular(keep.abs, keep.dir);
    const ds = regular(drop.abs, drop.dir);
    if (ks.dev !== ds.dev) throw new DedupeError("The files are on different disks");
    if (ks.ino === ds.ino) throw new DedupeError("Already stored once");
    if (ks.size !== ds.size) throw new DedupeError("The files are not identical any more; scan again");
    const [a, b] = await Promise.all([sha256Of(keep.abs), sha256Of(drop.abs)]);
    if (a !== sha || b !== sha) throw new DedupeError("The bytes no longer match what Grabbit saw; scan again");
    // Nothing may have changed while the files were read.
    const ks2 = regular(keep.abs, keep.dir);
    const ds2 = regular(drop.abs, drop.dir);
    if (ks2.ino !== ks.ino || ds2.ino !== ds.ino || ks2.mtimeMs !== ks.mtimeMs || ds2.mtimeMs !== ds.mtimeMs) {
      throw new DedupeError("A file changed while it was checked; try again");
    }
    const id = Number(
      ctx.db
        .prepare(
          `INSERT INTO grabbit_dedupe_journal (channel, keep_key, drop_key, role, sha256, bytes, state) VALUES (?, ?, ?, ?, ?, ?, 'pending')`
        )
        .run(drop.channel, keep.key, drop.key, dropRefs[0].role, sha, ds.size).lastInsertRowid
    );
    const trashDir = path.join(drop.dir, TRASH_DIR);
    // A random part makes the name unique even when a journal id comes back
    // (a restored database): an EEXIST rollback then never meets another
    // merge's held file.
    const trashName = `${id}-${crypto.randomBytes(4).toString("hex")}-${path.basename(drop.key).slice(0, 150)}`;
    // The trash name is on record before any file changes, so an interrupted
    // merge can still be restored or purged (see journal()).
    ctx.db.prepare(`UPDATE grabbit_dedupe_journal SET trash_name = ? WHERE id = ?`).run(trashName, id);
    const trashAbs = path.join(trashDir, trashName);
    const tmp = path.join(path.dirname(drop.abs), `.${path.basename(drop.abs).slice(0, 150)}.dedupe-${id}-${crypto.randomBytes(4).toString("hex")}`);
    let heldCreated = false;
    try {
      fs.mkdirSync(trashDir, { recursive: true });
      fs.linkSync(drop.abs, trashAbs); // the original stays reachable from the trash
      heldCreated = true;
      fs.linkSync(keep.abs, tmp);
      fs.renameSync(tmp, drop.abs); // atomic: the clip's name now holds the kept bytes
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch { /* not created */ }
      // Only a name this merge made is removed; an older file under the same
      // trash name (EEXIST) is someone else's and stays.
      try {
        const now = fs.lstatSync(drop.abs);
        if (heldCreated && now.ino === ds.ino) fs.unlinkSync(trashAbs);
      } catch { /* left for a manual look; journal says failed */ }
      ctx.db.prepare(`UPDATE grabbit_dedupe_journal SET state = 'failed', error = ?, done_at = datetime('now') WHERE id = ?`).run(String((e as Error).message).slice(0, 300), id);
      throw new DedupeError(`TikShortis could not merge the files (${(e as NodeJS.ErrnoException).code || (e as Error).message}); nothing changed`);
    }
    ctx.db.prepare(`UPDATE grabbit_dedupe_journal SET state = 'linked', trash_name = ?, done_at = datetime('now') WHERE id = ?`).run(trashName, id);
    return { id, bytes: ds.size, posts: dropRefs.map((r) => r.id) };
  } finally {
    busy = false;
  }
}

interface JournalRow {
  id: number;
  channel: Channel;
  keep_key: string;
  drop_key: string;
  trash_name: string | null;
  sha256: string;
  bytes: number;
  state: string;
}

function journal(ctx: Ctx, id: unknown): JournalRow {
  ensureJournal(ctx.db);
  // Only a positive integer (or its decimal string); Number(true) and
  // Number([1]) are 1, which would name another merge.
  const n = typeof id === "number" ? id : typeof id === "string" && /^[1-9][0-9]{0,15}$/.test(id) ? Number(id) : NaN;
  if (!Number.isSafeInteger(n) || n < 1) throw new DedupeError("Not a merge id", 400);
  const row = ctx.db.prepare(`SELECT * FROM grabbit_dedupe_journal WHERE id = ?`).get(n) as JournalRow | undefined;
  if (!row) throw new DedupeError("No such merge", 404);
  // A 'pending' row is a merge that was interrupted part way. Its trash name
  // is recorded before any file changed, and restore and purge are safe in
  // every state it can be in (held link only, or held original plus link).
  if (!["linked", "pending"].includes(row.state) || !row.trash_name || row.trash_name !== path.basename(row.trash_name)) {
    throw new DedupeError(`This merge is ${row.state}; nothing to do`);
  }
  return row;
}

export function restore(ctx: Ctx, id: unknown) {
  const row = journal(ctx, id);
  const dir = path.join(ctx.shortsRoot, row.channel);
  const trashAbs = path.join(dir, TRASH_DIR, row.trash_name as string);
  const drop = parsePath(ctx, `${row.channel}/${row.drop_key}`);
  const keep = parsePath(ctx, `${row.channel}/${row.keep_key}`);
  let held: fs.Stats;
  try {
    held = fs.lstatSync(trashAbs);
  } catch {
    throw new DedupeError("The held original is missing");
  }
  if (!held.isFile()) throw new DedupeError("The held original is not a file");
  let cur: fs.Stats | null = null;
  try {
    cur = fs.lstatSync(drop.abs);
  } catch {
    cur = null;
  }
  let keepIno: number | null = null;
  try {
    keepIno = fs.lstatSync(keep.abs).ino;
  } catch {
    keepIno = null;
  }
  if (cur && cur.ino !== held.ino && cur.ino !== keepIno) {
    throw new DedupeError(
      "The clip's file was replaced since the merge (re-transcoded or re-imported); restoring would overwrite the newer file",
      409,
      "Delete the held original instead, or restore it by hand."
    );
  }
  // A merge stopped before its rename leaves the clip's name on the held
  // original itself; renaming a name over the same inode is a no-op that
  // would strand the temp link, so there is nothing to move back.
  if (!cur || cur.ino !== held.ino) {
    const tmp = path.join(path.dirname(drop.abs), `.${path.basename(drop.abs).slice(0, 150)}.restore-${row.id}-${crypto.randomBytes(4).toString("hex")}`);
    fs.mkdirSync(path.dirname(drop.abs), { recursive: true });
    fs.linkSync(trashAbs, tmp);
    try {
      fs.renameSync(tmp, drop.abs);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch { /* not there */ }
      throw e;
    }
  }
  // State first: a held copy left behind by a crash after this point is a
  // harmless extra name, while the reverse order would strand the record.
  ctx.db.prepare(`UPDATE grabbit_dedupe_journal SET state = 'restored', done_at = datetime('now') WHERE id = ?`).run(row.id);
  try { fs.unlinkSync(trashAbs); } catch { /* an extra name of the restored file */ }
  return { id: row.id, restored: `${row.channel}/${row.drop_key}` };
}

export function purge(ctx: Ctx, id: unknown) {
  const row = journal(ctx, id);
  const trashAbs = path.join(ctx.shortsRoot, row.channel, TRASH_DIR, row.trash_name as string);
  let bytes = 0;
  try {
    const st = fs.lstatSync(trashAbs);
    if (!st.isFile()) throw new DedupeError("The held original is not a file");
    // Freed only if no live name shares it (the clip's own name was replaced
    // by the link, so normally nlink is 1 here).
    bytes = st.nlink === 1 ? st.size : 0;
    fs.unlinkSync(trashAbs);
  } catch (e) {
    if (e instanceof DedupeError) throw e;
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  ctx.db.prepare(`UPDATE grabbit_dedupe_journal SET state = 'purged', done_at = datetime('now') WHERE id = ?`).run(row.id);
  return { id: row.id, bytes };
}

export function status(ctx: Ctx) {
  ensureJournal(ctx.db);
  const rows = ctx.db.prepare(`SELECT state, COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS bytes FROM grabbit_dedupe_journal GROUP BY state`).all();
  return { version: 1, journal: rows };
}
