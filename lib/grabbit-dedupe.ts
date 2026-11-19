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
  /** Extra answer fields, e.g. { mayHaveChanged: true, id, uid }. */
  extra: Record<string, unknown> | null;
  constructor(message: string, status = 409, fix: string | null = null, extra: Record<string, unknown> | null = null) {
    super(message);
    this.status = status;
    this.fix = fix;
    this.extra = extra;
  }
}

// A mutation that failed after a file may already have changed. Grabbit keeps
// such an operation pending (with the id and uid) instead of closing it as
// "nothing changed".
function mayHaveChanged(message: string, id: number, uid: string | null): DedupeError {
  return new DedupeError(message, 422, "Check the clip in TikShortis; restore or purge this merge with its id and uid.", { mayHaveChanged: true, id, uid });
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
    done_at TEXT,
    uid TEXT,
    held_dev TEXT,
    held_ino TEXT,
    purged_bytes INTEGER,
    drop_refs TEXT
  )`);
  // Guarded ALTERs for journals created before these columns existed (same
  // pattern as lib/db.ts). Older rows keep uid NULL and can never be acted on
  // by uid; rows without held_dev/held_ino fall back to the checks made before
  // the held file's identity was recorded. Rows without drop_refs (the posts
  // that used the dropped file) cannot prove who owns the name and are
  // refused by restore.
  const cols = (db.prepare("PRAGMA table_info(grabbit_dedupe_journal)").all() as { name: string }[]).map((c) => c.name);
  for (const [name, type] of [["uid", "TEXT"], ["held_dev", "TEXT"], ["held_ino", "TEXT"], ["purged_bytes", "INTEGER"], ["drop_refs", "TEXT"]]) {
    if (cols.includes(name)) continue;
    try {
      db.exec(`ALTER TABLE grabbit_dedupe_journal ADD COLUMN ${name} ${type}`);
    } catch (e) {
      if (!String(e).includes("duplicate column name")) throw e;
    }
  }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS grabbit_dedupe_journal_uid ON grabbit_dedupe_journal (uid)");
}

// fsync a directory so a rename or link in it is on disk before the journal
// records the outcome.
// Only an fsync the filesystem does not support for directories (some FUSE
// and network mounts) is tolerated. Every other error, an open that fails
// (EACCES) or an I/O error, propagates: durability was not confirmed.
const NO_DIR_SYNC = new Set(["EINVAL", "EISDIR", "ENOTSUP"]);
function syncDir(dir: string) {
  const fd = fs.openSync(dir, "r");
  try {
    fs.fsyncSync(fd);
  } catch (e) {
    if (!NO_DIR_SYNC.has((e as NodeJS.ErrnoException).code || "")) throw e;
  } finally {
    fs.closeSync(fd);
  }
}

// fsync every directory from `dir` up to and including `top`: a name created
// in `dir`, and any folder created on the way down, are then on disk.
function syncUp(dir: string, top: string) {
  let cur = dir;
  for (;;) {
    syncDir(cur);
    if (cur === top) return;
    const up = path.dirname(cur);
    if (up === cur || path.relative(top, up).startsWith("..")) return;
    cur = up;
  }
}

// The held name's identity as recorded in the journal (decimal strings, from
// bigint stats so no inode number loses precision).
function identity(abs: string): { dev: string; ino: string } {
  const st = fs.lstatSync(abs, { bigint: true });
  return { dev: String(st.dev), ino: String(st.ino) };
}

// A row with a recorded identity accepts only that inode at its held name.
// Rows written before identities were recorded keep the older checks.
function heldMatches(row: { held_dev: string | null; held_ino: string | null }, abs: string): boolean {
  if (row.held_dev == null || row.held_ino == null) return true;
  const now = identity(abs);
  return now.dev === row.held_dev && now.ino === row.held_ino;
}

const HELD_REPLACED = "The held original was replaced since the merge (another file now has its name); nothing changed";

// Remove a name only if it is still the inode this operation put there.
function unlinkIfSame(abs: string, want: fs.Stats) {
  try {
    const st = fs.lstatSync(abs);
    if (st.dev === want.dev && st.ino === want.ino) fs.unlinkSync(abs);
  } catch { /* gone already, or left for a manual look */ }
}

// Every directory from the channel root down to the destination's parent must
// be a real directory (no symlink) whose real path is where it should be under
// the real channel root. Missing directories are allowed only when
// allowMissing is set (they are created afterwards and checked again).
function checkParents(rootDir: string, abs: string, allowMissing: boolean) {
  const realRoot = fs.realpathSync(rootDir);
  const parent = path.dirname(abs);
  const rel = path.relative(rootDir, parent);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new DedupeError("Not a library path", 400);
  const segs = rel ? rel.split(path.sep) : [];
  let cur = rootDir;
  for (const seg of segs) {
    cur = path.join(cur, seg);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(cur);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT" && allowMissing) return;
      throw new DedupeError(`A folder on the clip's path cannot be checked (${(e as NodeJS.ErrnoException).code || (e as Error).message}); nothing changed`);
    }
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new DedupeError("A folder on the clip's path is a link or not a folder; restoring could write outside the library, so nothing changed");
    }
  }
  if (fs.realpathSync(parent) !== path.join(realRoot, rel)) {
    throw new DedupeError("The clip's folder resolves outside the library; nothing changed");
  }
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
    // The id can come back after a database restore; the uid cannot. Grabbit
    // sends both on restore and purge, so an old reference never reaches a
    // newer merge that reused the id.
    const uid = crypto.randomBytes(16).toString("hex");
    const id = Number(
      ctx.db
        .prepare(
          `INSERT INTO grabbit_dedupe_journal (channel, keep_key, drop_key, role, sha256, bytes, state, uid, drop_refs) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
        )
        .run(drop.channel, keep.key, drop.key, dropRefs[0].role, sha, ds.size, uid, JSON.stringify(dropRefs.map((r) => r.id))).lastInsertRowid
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
    let stageCreated = false;
    // The inode the stage name got: the keeper may have been replaced before
    // the link, and the rollback removes the stage only as this inode.
    let staged: fs.Stats | null = null;
    try {
      const madeTrash = fs.mkdirSync(trashDir, { recursive: true }) !== undefined;
      fs.linkSync(drop.abs, trashAbs); // the original stays reachable from the trash
      heldCreated = true;
      // The held name (and the trash folder, if it is new) must be on disk
      // before the clip's name is changed.
      syncDir(trashDir);
      if (madeTrash) syncDir(drop.dir);
      // Restore and purge later accept only this inode at the held name.
      const held = identity(trashAbs);
      ctx.db.prepare(`UPDATE grabbit_dedupe_journal SET held_dev = ?, held_ino = ? WHERE id = ?`).run(held.dev, held.ino, id);
      fs.linkSync(keep.abs, tmp);
      stageCreated = true;
      staged = fs.lstatSync(tmp);
      // The syncs and journal writes above are slow disk I/O. Every check
      // comes after them and the rename follows at once, with nothing slow in
      // between: the held name is the hashed drop, the staged name is the
      // hashed keeper, and the clip's name still is the hashed drop.
      const hs = fs.lstatSync(trashAbs);
      const ss = staged;
      const live = fs.lstatSync(drop.abs);
      if (hs.dev !== ds.dev || hs.ino !== ds.ino) throw new DedupeError("The held original is not the file that was checked; nothing changed");
      if (ss.dev !== ks.dev || ss.ino !== ks.ino || ss.size !== ks.size || ss.mtimeMs !== ks.mtimeMs) {
        throw new DedupeError("The file to keep changed while the merge was prepared; nothing changed");
      }
      if (!live.isFile() || live.dev !== ds.dev || live.ino !== ds.ino || live.size !== ds.size || live.mtimeMs !== ds.mtimeMs) {
        throw new DedupeError("The clip's file changed while the merge was prepared; nothing changed");
      }
      fs.renameSync(tmp, drop.abs); // atomic: the clip's name now holds the kept bytes
      stageCreated = false;
    } catch (e) {
      // Only names this merge made are removed, and only while they still are
      // the inode it linked: an entry that was already there (EEXIST) is
      // someone else's and stays. A held name whose clip was replaced
      // meanwhile is kept: it may be the only name of the older file.
      if (stageCreated) unlinkIfSame(tmp, staged ?? ks);
      try {
        const now = fs.lstatSync(drop.abs);
        if (heldCreated && now.ino === ds.ino) unlinkIfSame(trashAbs, ds);
      } catch { /* left for a manual look; journal says failed */ }
      ctx.db.prepare(`UPDATE grabbit_dedupe_journal SET state = 'failed', error = ?, done_at = datetime('now') WHERE id = ?`).run(String((e as Error).message).slice(0, 300), id);
      if (e instanceof DedupeError) throw e;
      throw new DedupeError(`TikShortis could not merge the files (${(e as NodeJS.ErrnoException).code || (e as Error).message}); nothing changed`);
    }
    // The clip's name has changed: from here on a failure is never answered
    // as "nothing changed".
    let durable = true;
    try {
      // The new clip name should be on disk before the journal says linked.
      // The merge is done either way, so a failed sync is reported in the
      // answer (durable: false), not as a failure.
      syncDir(path.dirname(drop.abs));
    } catch (e) {
      durable = false;
      console.error(`[grabbit-dedupe] merge ${id}: the clip's folder could not be synced (${(e as NodeJS.ErrnoException).code || (e as Error).message})`);
    }
    try {
      ctx.db.prepare(`UPDATE grabbit_dedupe_journal SET state = 'linked', trash_name = ?, error = ?, done_at = datetime('now') WHERE id = ?`).run(trashName, durable ? null : "clip folder sync failed", id);
    } catch (e) {
      throw mayHaveChanged(`TikShortis merged the files but could not record it (${(e as Error).message}); merge ${id} is pending and can be restored`, id, uid);
    }
    return { id, uid, bytes: ds.size, posts: dropRefs.map((r) => r.id), durable };
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
  role: "video" | "poster";
  bytes: number;
  state: string;
  uid: string | null;
  held_dev: string | null;
  held_ino: string | null;
  purged_bytes: number | null;
  drop_refs: string | null;
}

// The post ids that used the dropped file when it was merged, or null for a
// row written before they were recorded.
function dropOwners(row: JournalRow): number[] | null {
  if (row.drop_refs == null) return null;
  try {
    const ids = JSON.parse(row.drop_refs);
    return Array.isArray(ids) && ids.length && ids.every((n) => Number.isSafeInteger(n) && n > 0) ? ids : null;
  } catch {
    return null;
  }
}

// The row for {id, uid}. A retry of the action that already completed it
// (restore of a restored row, purge of a purged row, for example after a lost
// response) returns the row with replay set, so the caller answers the same
// success again. The opposite action stays refused.
function journal(ctx: Ctx, id: unknown, uid: unknown, op: "restore" | "purge"): JournalRow & { replay: boolean } {
  ensureJournal(ctx.db);
  // Only a positive integer (or its decimal string); Number(true) and
  // Number([1]) are 1, which would name another merge.
  const n = typeof id === "number" ? id : typeof id === "string" && /^[1-9][0-9]{0,15}$/.test(id) ? Number(id) : NaN;
  if (!Number.isSafeInteger(n) || n < 1) throw new DedupeError("Not a merge id", 400);
  if (typeof uid !== "string" || !/^[0-9a-f]{32}$/.test(uid)) {
    throw new DedupeError("The merge uid is missing or malformed; nothing changed", 409, "Send the uid the link response returned together with the id.");
  }
  const row = ctx.db.prepare(`SELECT * FROM grabbit_dedupe_journal WHERE id = ?`).get(n) as JournalRow | undefined;
  if (!row) throw new DedupeError("No such merge", 404);
  // Fail closed: a row without a uid (made before uids existed) or with
  // another uid is not the merge the caller means (the id was reused, for
  // example after a database restore).
  if (!row.uid || row.uid.length !== uid.length || !crypto.timingSafeEqual(Buffer.from(row.uid), Buffer.from(uid))) {
    throw new DedupeError("This merge id belongs to a different merge than the one Grabbit recorded (uid mismatch); nothing changed", 409, "Check the merge by hand in TikShortis before acting on it.");
  }
  if ((op === "restore" && row.state === "restored") || (op === "purge" && row.state === "purged")) {
    return { ...row, replay: true };
  }
  // A 'pending' row is a merge that was interrupted part way. Its trash name
  // is recorded before any file changed, and restore and purge are safe in
  // every state it can be in (held link only, or held original plus link).
  if (!["linked", "pending"].includes(row.state) || !row.trash_name || row.trash_name !== path.basename(row.trash_name)) {
    throw new DedupeError(`This merge is ${row.state}; nothing to do`);
  }
  return { ...row, replay: false };
}

export function restore(ctx: Ctx, id: unknown, uid: unknown) {
  const row = journal(ctx, id, uid, "restore");
  if (row.replay) return { id: row.id, restored: `${row.channel}/${row.drop_key}` };
  const dir = path.join(ctx.shortsRoot, row.channel);
  const trashAbs = path.join(dir, TRASH_DIR, row.trash_name as string);
  const drop = parsePath(ctx, `${row.channel}/${row.drop_key}`);
  const keep = parsePath(ctx, `${row.channel}/${row.keep_key}`);
  let held: fs.Stats;
  try {
    held = fs.lstatSync(trashAbs);
  } catch {
    // A restore that put the original back and removed its held name, but
    // could not record that (a crash, a failed journal write), leaves the
    // clip's name on the held inode: finish recording it. Only a row with a
    // recorded identity can tell that inode apart.
    if (row.held_dev != null && row.held_ino != null) {
      let back = false;
      try {
        const now = identity(drop.abs);
        back = now.dev === row.held_dev && now.ino === row.held_ino;
      } catch {
        back = false;
      }
      if (back) {
        try {
          ctx.db.prepare(`UPDATE grabbit_dedupe_journal SET state = 'restored', done_at = datetime('now') WHERE id = ?`).run(row.id);
        } catch (e) {
          throw mayHaveChanged(`The original is back but TikShortis could not record it (${(e as Error).message}); try the restore again`, row.id, row.uid);
        }
        return { id: row.id, restored: `${row.channel}/${row.drop_key}` };
      }
    }
    throw new DedupeError("The held original is missing");
  }
  if (!held.isFile()) throw new DedupeError("The held original is not a file");
  if (!heldMatches(row, trashAbs)) throw new DedupeError(HELD_REPLACED, 409, "Check the trash folder by hand in TikShortis.");
  // The clip must still name this file. A clip moved to another profile (or
  // renamed, or deleted) points elsewhere now; restoring would recreate a
  // file no clip uses.
  const owners = dropOwners(row);
  if (!owners) {
    throw new DedupeError(
      "This merge was recorded before TikShortis kept which posts used the file, so it cannot check that restoring is safe; nothing changed",
      409,
      "Check the clip by hand in TikShortis and restore the held original manually if it is still needed."
    );
  }
  const refs = refsOf(ctx.db, row.channel, row.drop_key).filter((r) => r.role === row.role);
  if (!refs.length) {
    throw new DedupeError(
      "No clip uses the merged file's name any more (the clip was moved, renamed or deleted); restoring would create a file no clip uses, so nothing changed",
      409,
      "Delete the held original instead, or restore it by hand."
    );
  }
  // Only a post that used the file at merge time may get it back: a later
  // upload that reuses the name (after the original post moved) is another
  // clip, and the held original would overwrite or stand in for its file.
  if (!refs.some((r) => owners.includes(r.id))) {
    throw new DedupeError(
      "The posts that used the merged file no longer use its name (another post uses it now); nothing changed",
      409,
      "Delete the held original instead, or restore it by hand."
    );
  }
  // Before any change, also when the clip's name is absent: no folder between
  // the channel root and the clip may have become a link since the merge.
  checkParents(dir, drop.abs, true);
  let cur: fs.Stats | null = null;
  try {
    cur = fs.lstatSync(drop.abs);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new DedupeError(`The clip's file cannot be checked (${(e as NodeJS.ErrnoException).code || (e as Error).message}); nothing changed`);
    }
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
    // Again with every folder present: none may be missing or a link now.
    checkParents(dir, drop.abs, false);
    fs.linkSync(trashAbs, tmp);
    // What is about to be put back must be the inode the merge held.
    const staged = fs.lstatSync(tmp);
    if (staged.dev !== held.dev || staged.ino !== held.ino || !heldMatches(row, tmp)) {
      unlinkIfSame(tmp, staged);
      throw new DedupeError(HELD_REPLACED, 409, "Check the trash folder by hand in TikShortis.");
    }
    // The last look at the clip's name right before the rename replaces it:
    // still what was checked above (or still absent).
    let again: fs.Stats | null = null;
    try {
      again = fs.lstatSync(drop.abs);
    } catch {
      again = null;
    }
    if ((cur == null) !== (again == null) || (cur && again && (cur.dev !== again.dev || cur.ino !== again.ino))) {
      unlinkIfSame(tmp, held);
      throw new DedupeError("The clip's file changed while restoring; the held original is kept, nothing changed");
    }
    try {
      fs.renameSync(tmp, drop.abs);
    } catch (e) {
      unlinkIfSame(tmp, held);
      throw e;
    }
  }
  // On every path, also a retry that finds the clip's name already on the
  // held inode: the clip's name, and every folder on its way (some may have
  // been created just now or by an earlier attempt), must be on disk before
  // the journal says restored and the held name goes. A failure here leaves
  // the row as it was and the held name in place, so a retry finishes it.
  try {
    syncUp(path.dirname(drop.abs), dir);
  } catch (e) {
    throw mayHaveChanged(
      `TikShortis put the original back but could not confirm it on disk (${(e as NodeJS.ErrnoException).code || (e as Error).message}); the held original is kept, try the restore again`,
      row.id,
      row.uid
    );
  }
  // From here on the clip's name may already be the original again, so
  // every failure says the filesystem may have changed (422 mayHaveChanged
  // with the id and uid); Grabbit then keeps the operation open.
  //
  // The syncs were slow disk I/O: the clip's name must still be the held
  // inode, or a writer replaced it and the held name is the original's only
  // name, which then stays. The row turns 'restored' only after the held
  // name is gone, so no retry can answer success for a restore that did not
  // happen; a crash between the two is finished by the next restore call
  // (see the missing-held branch above).
  const stillHeld = () => {
    try {
      const st = fs.lstatSync(drop.abs);
      return st.dev === held.dev && st.ino === held.ino;
    } catch {
      return false;
    }
  };
  if (!stillHeld()) {
    throw mayHaveChanged("The clip's file was replaced while it was being restored; the held original is kept", row.id, row.uid);
  }
  unlinkIfSame(trashAbs, held); // an extra name of the restored file if it stays
  try {
    ctx.db.prepare(`UPDATE grabbit_dedupe_journal SET state = 'restored', done_at = datetime('now') WHERE id = ?`).run(row.id);
  } catch (e) {
    throw mayHaveChanged(`The original is back but TikShortis could not record it (${(e as Error).message}); try the restore again`, row.id, row.uid);
  }
  return { id: row.id, restored: `${row.channel}/${row.drop_key}` };
}

export function purge(ctx: Ctx, id: unknown, uid: unknown) {
  const row = journal(ctx, id, uid, "purge");
  if (row.replay) return { id: row.id, bytes: row.purged_bytes ?? 0 };
  const trashAbs = path.join(ctx.shortsRoot, row.channel, TRASH_DIR, row.trash_name as string);
  let bytes = 0;
  let unlinked = false;
  try {
    const st = fs.lstatSync(trashAbs);
    if (!st.isFile()) throw new DedupeError("The held original is not a file");
    if (!heldMatches(row, trashAbs)) throw new DedupeError(HELD_REPLACED, 409, "Check the trash folder by hand in TikShortis.");
    // Freed only if no live name shares it (the clip's own name was replaced
    // by the link, so normally nlink is 1 here).
    bytes = st.nlink === 1 ? st.size : 0;
    fs.unlinkSync(trashAbs);
    unlinked = true;
  } catch (e) {
    if (e instanceof DedupeError) throw e;
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  try {
    ctx.db.prepare(`UPDATE grabbit_dedupe_journal SET state = 'purged', purged_bytes = ?, done_at = datetime('now') WHERE id = ?`).run(bytes, row.id);
  } catch (e) {
    // The held original is gone already: Grabbit must not offer it again.
    if (unlinked) throw mayHaveChanged(`The held original was deleted but TikShortis could not record it (${(e as Error).message}); try the purge again`, row.id, row.uid);
    throw e;
  }
  return { id: row.id, bytes };
}

export function status(ctx: Ctx) {
  ensureJournal(ctx.db);
  const rows = ctx.db.prepare(`SELECT state, COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS bytes FROM grabbit_dedupe_journal GROUP BY state`).all();
  return { version: 1, journal: rows };
}
