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
 *   hold    A file no clip uses (an "orphan": left behind by an old double
 *           import) whose bytes a live clip has too. The file, and its
 *           poster frame if that is an orphan too, is moved into
 *           .grabbit-dedupe-trash; restore puts it back. No clip changes.
 *   restore Undo a link or a hold.
 *   purge   Delete a held original for good.
 *   lookup  Which posts use a file (for the review screen).
 *   opstatus What became of a link call whose answer Grabbit lost (by the
 *           key Grabbit sent with it).
 *
 * No row changes: storage_key and poster_key keep pointing at the same names.
 * A clip's name is swapped by taking it aside and linking the new file in
 * (see replaceWith), all in one synchronous run with no await, so the orphan
 * sweep, which runs in this process and is synchronous too, can never see a
 * clip without its file. A clip later
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
  /** How old a file must be before hold takes it (tests only; default HOLD_MIN_AGE_MS). */
  holdMinAgeMs?: number;
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
    drop_refs TEXT,
    keep_dev TEXT,
    keep_ino TEXT,
    held_action TEXT,
    kind TEXT,
    poster_key TEXT,
    poster_trash TEXT,
    poster_dev TEXT,
    poster_ino TEXT
  )`);
  // Guarded ALTERs for journals created before these columns existed (same
  // pattern as lib/db.ts). Older rows keep uid NULL and can never be acted on
  // by uid; rows without held_dev/held_ino fall back to the checks made before
  // the held file's identity was recorded. Rows without drop_refs (the posts
  // that used the dropped file) cannot prove who owns the name and are
  // refused by restore. keep_dev/keep_ino are the inode the merge put at the
  // clip's name (the verified keeper); rows without them fall back to the
  // keeper's current path. held_action ('restore' or 'purge') is written
  // before the held name is removed, so a retry finishes that action and the
  // other one is refused. (The state CHECK cannot be altered in place, hence
  // a column rather than a new state.)
  // kind is 'hold' for a held orphan (NULL = a link). A hold row uses the
  // same states: 'linked' means held. Its keep_key is the twin (the live clip
  // with the same bytes, which purge requires), drop_key the orphan, and
  // poster_* the orphan poster frame held with it, if any.
  const cols = (db.prepare("PRAGMA table_info(grabbit_dedupe_journal)").all() as { name: string }[]).map((c) => c.name);
  for (const [name, type] of [["uid", "TEXT"], ["held_dev", "TEXT"], ["held_ino", "TEXT"], ["purged_bytes", "INTEGER"], ["drop_refs", "TEXT"], ["keep_dev", "TEXT"], ["keep_ino", "TEXT"], ["held_action", "TEXT"], ["kind", "TEXT"], ["poster_key", "TEXT"], ["poster_trash", "TEXT"], ["poster_dev", "TEXT"], ["poster_ino", "TEXT"]]) {
    if (cols.includes(name)) continue;
    try {
      db.exec(`ALTER TABLE grabbit_dedupe_journal ADD COLUMN ${name} ${type}`);
    } catch (e) {
      if (!String(e).includes("duplicate column name")) throw e;
    }
  }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS grabbit_dedupe_journal_uid ON grabbit_dedupe_journal (uid)");
  // Grabbit's key for each link call. A link answer lost on the way (a
  // timeout, a cut connection) leaves Grabbit not knowing whether the merge
  // happened; opstatus answers that by the key. state: 'started' (the link
  // claimed the key; journal_id is set once it wrote its journal row, before
  // any file changes), 'refused' (it stopped before changing anything) or
  // 'fenced' (opstatus found no link with that key and closed it, so a late
  // link with the key is refused and the answer "nothing changed" stays true).
  db.exec(`CREATE TABLE IF NOT EXISTS grabbit_dedupe_ops (
    op TEXT PRIMARY KEY,
    state TEXT NOT NULL CHECK (state IN ('started', 'refused', 'fenced')),
    journal_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
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

// Linux has no unlink-if-inode and Node has no renameat2, so the last check
// and the change after it are two system calls, and a writer (the
// transcoder, an import) can replace the clip's name in between. The name is
// therefore never replaced blind: it is first renamed aside, to a random name
// in the same folder (atomic, a name no one else knows), and only what was
// taken aside is judged. Anything other than the checked file goes back under
// its name (a link, which never clobbers), so the writer's file is never lost.
// The new file then comes in with a link too: a name made in the moment
// between wins. Returns false when the name held another file (put back;
// `stage` stays for the caller to undo).
function putBack(aside: string, abs: string) {
  try {
    fs.linkSync(aside, abs);
  } catch (e) {
    console.error(`[grabbit-dedupe] ${path.basename(abs)} changed again meanwhile; the file that held its name stays at ${aside} (${(e as NodeJS.ErrnoException).code || (e as Error).message})`);
    return;
  }
  try { fs.unlinkSync(aside); } catch { /* an extra name of the same file */ }
}

function replaceWith(abs: string, match: (st: fs.Stats) => boolean, stage: string): boolean {
  const aside = path.join(path.dirname(abs), `.${path.basename(abs).slice(0, 150)}.aside-${crypto.randomBytes(4).toString("hex")}`);
  fs.renameSync(abs, aside);
  let st: fs.Stats | null = null;
  try { st = fs.lstatSync(aside); } catch { st = null; }
  if (!st || !st.isFile() || !match(st)) {
    putBack(aside, abs);
    return false;
  }
  try {
    fs.linkSync(stage, abs);
  } catch (e) {
    putBack(aside, abs);
    throw e;
  }
  try { fs.unlinkSync(stage); } catch { /* an extra name of the new file */ }
  try { fs.unlinkSync(aside); } catch { /* an extra name of the checked file */ }
  return true;
}

// Removes the held name for a finished restore or purge. "removed" or "gone"
// (ENOENT) means the name no longer holds `want`; "other" means another file
// has the name now and was left alone. Every other error (EACCES, EIO, ...)
// propagates: whether the name is gone is then unknown.
function removeHeld(abs: string, want: fs.Stats): "removed" | "gone" | "other" {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(abs);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "gone";
    throw e;
  }
  if (st.dev !== want.dev || st.ino !== want.ino) return "other";
  try {
    fs.unlinkSync(abs);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "gone";
    throw e;
  }
  return "removed";
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

// Link calls running in this process, by Grabbit's key.
const runningOps = new Set<string>();

function opKey(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v !== "string" || !/^[0-9a-f]{32}$/.test(v)) throw new DedupeError("op must be 32 hex characters", 400);
  return v;
}

type LinkBody = { keep?: unknown; drop?: unknown; sha256?: unknown; op?: unknown };

export async function link(ctx: Ctx, body: LinkBody) {
  return withOp(ctx, body.op, (op) => linkFiles(ctx, body, op));
}

// Runs a link or hold under Grabbit's key `op` (if sent), so opstatus can
// answer for it when the answer is lost.
async function withOp<T>(ctx: Ctx, v: unknown, run: (op: string | null) => Promise<T>): Promise<T> {
  ensureJournal(ctx.db);
  const op = opKey(v);
  if (!op) return run(null);
  // The key is claimed before anything else; a key seen before (a repeated
  // call, or one opstatus already closed) is refused and changes nothing.
  try {
    ctx.db.prepare("INSERT INTO grabbit_dedupe_ops (op, state) VALUES (?, 'started')").run(op);
  } catch (e) {
    if (String(e).includes("UNIQUE")) throw new DedupeError("This request was already received or checked; nothing changed", 409);
    throw e;
  }
  runningOps.add(op);
  try {
    return await run(op);
  } catch (e) {
    // Stopped before its journal row: nothing was changed. After it, the
    // journal row says what happened.
    try { ctx.db.prepare("UPDATE grabbit_dedupe_ops SET state = 'refused' WHERE op = ? AND journal_id IS NULL").run(op); } catch { /* opstatus sees started, not running */ }
    throw e;
  } finally {
    runningOps.delete(op);
  }
}

// What became of the link call with Grabbit's key `op`. A key no link has
// claimed is fenced, so the answer "not found" cannot turn false later.
export async function opStatus(ctx: Ctx, v: unknown) {
  ensureJournal(ctx.db);
  const op = opKey(v);
  if (!op) throw new DedupeError("op is required", 400);
  ctx.db.prepare("INSERT OR IGNORE INTO grabbit_dedupe_ops (op, state) VALUES (?, 'fenced')").run(op);
  const r = ctx.db.prepare("SELECT state, journal_id FROM grabbit_dedupe_ops WHERE op = ?").get(op) as { state: string; journal_id: number | null };
  if (r.state === "started" && r.journal_id == null) {
    if (runningOps.has(op)) return { op, found: true, inProgress: true };
    // Claimed, but the process stopped before the journal row (a restart):
    // no file was changed. Closed so the answer stays true.
    ctx.db.prepare("UPDATE grabbit_dedupe_ops SET state = 'refused' WHERE op = ? AND journal_id IS NULL").run(op);
    return { op, found: false };
  }
  if (r.journal_id == null) return { op, found: false };
  const j = ctx.db.prepare("SELECT id, uid, bytes, state, drop_refs FROM grabbit_dedupe_journal WHERE id = ?").get(r.journal_id) as
    | { id: number; uid: string | null; bytes: number; state: string; drop_refs: string | null }
    | undefined;
  if (!j) throw new DedupeError("The journal row for this merge is missing; check by hand", 409);
  let posts: number[] = [];
  try { posts = JSON.parse(j.drop_refs || "[]"); } catch { posts = []; }
  const running = runningOps.has(op);
  let state = j.state;
  let stopped = false;
  if (state === "pending" && !running && !busy) {
    state = await reconcileStopped(ctx, j.id);
    stopped = state === "pending";
  }
  return { op, found: true, inProgress: running, id: j.id, uid: j.uid, bytes: j.bytes, state, stopped, posts };
}

// A 'pending' row whose merge is not running any more (the process stopped
// part way). The files show how far it got:
// - the clip still holds its original and no held name exists, or the held
//   name is only a second name of that same original: nothing changed (the
//   extra held name is removed) -> 'failed';
// - the held name is the recorded original and the clip holds the recorded
//   keeper inode, and both still hash to the journaled bytes (an inode can be
//   rewritten in place): the merge finished but was not recorded -> 'linked';
// - anything else cannot be told apart safely -> stays 'pending' for a check
//   by hand. Only 'linked' lets Grabbit list it as a restorable merge.
async function reconcileStopped(ctx: Ctx, id: number): Promise<string> {
  const row = ctx.db.prepare(`SELECT * FROM grabbit_dedupe_journal WHERE id = ?`).get(id) as JournalRow | undefined;
  if (!row || row.state !== "pending") return row ? row.state : "pending";
  if (row.kind === "hold") return reconcileHold(ctx, row);
  try {
    const drop = parsePath(ctx, `${row.channel}/${row.drop_key}`);
    const trashAbs = row.trash_name && row.trash_name === path.basename(row.trash_name)
      ? path.join(ctx.shortsRoot, row.channel, TRASH_DIR, row.trash_name)
      : null;
    const look = (abs: string): fs.Stats | null | "error" => {
      try {
        return fs.lstatSync(abs);
      } catch (e) {
        return (e as NodeJS.ErrnoException).code === "ENOENT" ? null : "error";
      }
    };
    const d = look(drop.abs);
    const h = trashAbs ? look(trashAbs) : null;
    if (d === "error" || h === "error") return "pending";
    const dId = d && d.isFile() ? identity(drop.abs) : null;
    const isKeep = !!dId && row.keep_dev != null && row.keep_ino != null && dId.dev === row.keep_dev && dId.ino === row.keep_ino;
    const fail = (why: string) => {
      ctx.db.prepare(`UPDATE grabbit_dedupe_journal SET state = 'failed', error = ?, done_at = datetime('now') WHERE id = ? AND state = 'pending'`).run(why, row.id);
      return "failed";
    };
    if (!h) {
      // No held name: the clip was never swapped (the keeper's inode on
      // record is written before the swap, and the held name before that).
      if (d && d.isFile() && !isKeep && row.held_ino == null) return fail("stopped before any file changed");
      return "pending";
    }
    if (!h.isFile() || !heldMatches(row, trashAbs as string) || row.held_ino == null) return "pending";
    if (isKeep) {
      // Same inodes do not prove the bytes: either file may have been
      // rewritten in place since. Both must hash to the journaled SHA-256,
      // and afterwards still be the same files, unchanged, before the merge
      // is certified as restorable. Anything else stays pending.
      const held = trashAbs as string;
      const [hh, dh] = await Promise.all([sha256Of(held), sha256Of(drop.abs)]);
      if (hh !== row.sha256 || dh !== row.sha256) return "pending";
      const same = (a: fs.Stats | null | "error", b: fs.Stats) =>
        !!a && a !== "error" && a.isFile() && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
      const cur = ctx.db.prepare(`SELECT state FROM grabbit_dedupe_journal WHERE id = ?`).get(row.id) as { state: string } | undefined;
      if (!cur || cur.state !== "pending" || busy) return cur ? cur.state : "pending";
      if (!same(look(held), h) || !same(look(drop.abs), d as fs.Stats) || !heldMatches(row, held)) return "pending";
      const dNow = identity(drop.abs);
      if (dNow.dev !== row.keep_dev || dNow.ino !== row.keep_ino) return "pending";
      ctx.db.prepare(`UPDATE grabbit_dedupe_journal SET state = 'linked', error = ?, done_at = datetime('now') WHERE id = ? AND state = 'pending'`).run("finished before a stop, recorded later", row.id);
      return "linked";
    }
    if (d && d.isFile() && d.dev === h.dev && d.ino === h.ino) {
      // The clip still holds its original: the held name is a second name of
      // it and goes again. Checked once more right before.
      const now = look(drop.abs);
      if (now && now !== "error" && now.dev === h.dev && now.ino === h.ino && removeHeld(trashAbs as string, h) !== "other") {
        syncDir(path.dirname(trashAbs as string));
        return fail("stopped before the clip changed");
      }
    }
    return "pending";
  } catch {
    return "pending";
  }
}

async function linkFiles(ctx: Ctx, body: LinkBody, op: string | null) {
  const keep = parsePath(ctx, body.keep);
  const drop = parsePath(ctx, body.drop);
  const sha = typeof body.sha256 === "string" && /^[0-9a-f]{64}$/.test(body.sha256) ? body.sha256 : null;
  if (!sha) throw new DedupeError("sha256 is required", 400);
  if (keep.channel !== drop.channel) throw new DedupeError("The clips are in different sections (main and 18+); they never share a file");
  if (keep.abs === drop.abs) throw new DedupeError("Choose two different files");
  const keepRefs = refsOf(ctx.db, keep.channel, keep.key);
  const dropRefs = refsOf(ctx.db, drop.channel, drop.key);
  if (!dropRefs.length) throw new DedupeError("No clip uses this file, so TikShortis does not merge it", 409, "If it is a leftover, hold it in TikShortis' dedupe trash from Grabbit instead.");
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
    // The hashing can take long: an app operation may meanwhile have moved,
    // deleted or reassigned a post while the file names stayed. The posts
    // and roles are read again and must be what was checked above.
    const keepNow = refsOf(ctx.db, keep.channel, keep.key);
    const dropNow = refsOf(ctx.db, drop.channel, drop.key);
    const sig = (refs: RefRow[]) => refs.map((r) => `${r.id}:${r.role}`).join(",");
    if (!keepNow.length || sig(dropNow) !== sig(dropRefs) || keepNow[0].role !== dropRefs[0].role) {
      throw new DedupeError("The posts using these files changed while they were checked; scan again");
    }
    // The id can come back after a database restore; the uid cannot. Grabbit
    // sends both on restore and purge, so an old reference never reaches a
    // newer merge that reused the id.
    const uid = crypto.randomBytes(16).toString("hex");
    // The journal row and the key's link to it go in together, before any
    // file changes.
    const id = ctx.db.transaction(() => {
      const jid = Number(
        ctx.db
          .prepare(
            `INSERT INTO grabbit_dedupe_journal (channel, keep_key, drop_key, role, sha256, bytes, state, uid, drop_refs) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
          )
          .run(drop.channel, keep.key, drop.key, dropRefs[0].role, sha, ds.size, uid, JSON.stringify(dropRefs.map((r) => r.id))).lastInsertRowid
      );
      if (op && ctx.db.prepare("UPDATE grabbit_dedupe_ops SET journal_id = ? WHERE op = ? AND state = 'started'").run(jid, op).changes !== 1) {
        throw new DedupeError("This merge request was closed meanwhile; nothing changed", 409);
      }
      return jid;
    })();
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
      fs.mkdirSync(trashDir, { recursive: true });
      fs.linkSync(drop.abs, trashAbs); // the original stays reachable from the trash
      heldCreated = true;
      // The held name and the trash folder's own entry in the channel root
      // must be on disk before the clip's name is changed. Both are synced on
      // every attempt: a first attempt may have made the folder and failed
      // before its parent was synced, and a retry finds it already there.
      syncDir(trashDir);
      syncDir(drop.dir);
      // Restore and purge later accept only this inode at the held name.
      const held = identity(trashAbs);
      ctx.db.prepare(`UPDATE grabbit_dedupe_journal SET held_dev = ?, held_ino = ? WHERE id = ?`).run(held.dev, held.ino, id);
      fs.linkSync(keep.abs, tmp);
      stageCreated = true;
      staged = fs.lstatSync(tmp);
      // The inode the clip's name will hold after the rename, so a restore
      // can recognise it even when the keeper post is later renamed or
      // deleted. Written before the last checks (slow I/O stays before them).
      const st = identity(tmp);
      ctx.db.prepare(`UPDATE grabbit_dedupe_journal SET keep_dev = ?, keep_ino = ? WHERE id = ?`).run(st.dev, st.ino, id);
      // The syncs and journal writes above are slow disk I/O. Every check
      // comes after them and the rename follows at once, with nothing slow in
      // between: the held name is the hashed drop, the staged name is the
      // hashed keeper (read again now, not the stat from before the journal
      // write) and the inode on record, and the clip's name still is the
      // hashed drop.
      const hs = fs.lstatSync(trashAbs);
      const ss = fs.lstatSync(tmp);
      const sNow = identity(tmp);
      const live = fs.lstatSync(drop.abs);
      if (hs.dev !== ds.dev || hs.ino !== ds.ino) throw new DedupeError("The held original is not the file that was checked; nothing changed");
      if (!ss.isFile() || ss.dev !== ks.dev || ss.ino !== ks.ino || ss.size !== ks.size || ss.mtimeMs !== ks.mtimeMs || sNow.dev !== st.dev || sNow.ino !== st.ino) {
        throw new DedupeError("The file to keep changed while the merge was prepared; nothing changed");
      }
      if (!live.isFile() || live.dev !== ds.dev || live.ino !== ds.ino || live.size !== ds.size || live.mtimeMs !== ds.mtimeMs) {
        throw new DedupeError("The clip's file changed while the merge was prepared; nothing changed");
      }
      // The clip's name now holds the kept bytes. It is taken aside first, so
      // a file a writer put there after the look above goes back instead of
      // being overwritten.
      if (!replaceWith(drop.abs, (n) => n.dev === ds.dev && n.ino === ds.ino && n.size === ds.size && n.mtimeMs === ds.mtimeMs, tmp)) {
        throw new DedupeError("The clip's file changed while the merge was prepared; nothing changed");
      }
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
  keep_dev: string | null;
  keep_ino: string | null;
  held_action: string | null;
  kind: string | null;
  poster_key: string | null;
  poster_trash: string | null;
  poster_dev: string | null;
  poster_ino: string | null;
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
  if (row.kind === "hold") return restoreHold(ctx, row);
  const dir = path.join(ctx.shortsRoot, row.channel);
  const trashAbs = path.join(dir, TRASH_DIR, row.trash_name as string);
  const drop = parsePath(ctx, `${row.channel}/${row.drop_key}`);
  const keep = parsePath(ctx, `${row.channel}/${row.keep_key}`);
  let held: fs.Stats;
  try {
    held = fs.lstatSync(trashAbs);
  } catch (e) {
    // Only a name that is certainly absent is "missing". EACCES or EIO says
    // nothing about it, so nothing is recorded.
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new DedupeError(`The held original cannot be checked (${(e as NodeJS.ErrnoException).code || (e as Error).message}); nothing changed`);
    }
    // A purge had started removing the held name: it is not coming back.
    if (row.held_action === "purge") {
      throw new DedupeError("A delete of this merge's held original was under way; nothing changed", 409, "Delete it again to finish the delete.");
    }
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
  // The inode the merge put at the clip's name: recorded at link time, or
  // for an older row the keeper's current file.
  let isMerged = false;
  if (cur) {
    if (row.keep_dev != null && row.keep_ino != null) {
      const now = identity(drop.abs);
      isMerged = now.dev === row.keep_dev && now.ino === row.keep_ino;
    } else {
      try {
        const k = fs.lstatSync(keep.abs);
        isMerged = k.dev === cur.dev && k.ino === cur.ino;
      } catch {
        isMerged = false;
      }
    }
  }
  if (cur && cur.ino !== held.ino && !isMerged) {
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
    // Only ENOENT means absent: an EIO or EACCES says nothing about the
    // name, so the restore stops and the held original stays.
    let again: fs.Stats | null = null;
    try {
      again = fs.lstatSync(drop.abs);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        unlinkIfSame(tmp, held);
        throw new DedupeError(`The clip's file cannot be checked (${(e as NodeJS.ErrnoException).code || (e as Error).message}); the held original is kept, nothing changed`);
      }
      again = null;
    }
    if ((cur == null) !== (again == null) || (cur && again && (cur.dev !== again.dev || cur.ino !== again.ino))) {
      unlinkIfSame(tmp, held);
      throw new DedupeError("The clip's file changed while restoring; the held original is kept, nothing changed");
    }
    // An absent name is made with a link, which never clobbers; a present one
    // (the merged inode) is taken aside first and goes back if it is not.
    // Either way a file a writer put there after the look above stays.
    let placed = false;
    try {
      if (again == null) {
        fs.linkSync(tmp, drop.abs);
        unlinkIfSame(tmp, held);
        placed = true;
      } else {
        const want = again;
        placed = replaceWith(drop.abs, (n) => n.dev === want.dev && n.ino === want.ino, tmp);
      }
    } catch (e) {
      unlinkIfSame(tmp, held);
      if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new DedupeError("The clip's file changed while restoring; the held original is kept, nothing changed");
      throw e;
    }
    if (!placed) {
      unlinkIfSame(tmp, held);
      throw new DedupeError("The clip's file changed while restoring; the held original is kept, nothing changed");
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
  // The intended action is on record before the held name goes, so a
  // retry after a lost journal write finishes this restore and a purge
  // cannot take the missing held name for a finished delete.
  try {
    ctx.db.prepare(`UPDATE grabbit_dedupe_journal SET held_action = 'restore' WHERE id = ?`).run(row.id);
  } catch (e) {
    throw mayHaveChanged(`TikShortis put the original back but could not record it (${(e as Error).message}); the held original is kept, try the restore again`, row.id, row.uid);
  }
  if (!stillHeld()) {
    throw mayHaveChanged("The clip's file was replaced while it was being restored; the held original is kept", row.id, row.uid);
  }
  // The held name is an extra name of the restored file now. It must be
  // gone (or hold another file) before the row says restored; a failure to
  // remove it keeps the row as it is, so a retry removes it.
  try {
    removeHeld(trashAbs, held);
  } catch (e) {
    throw mayHaveChanged(
      `The original is back, but TikShortis could not remove its held copy (${(e as NodeJS.ErrnoException).code || (e as Error).message}); try the restore again`,
      row.id,
      row.uid
    );
  }
  try {
    ctx.db.prepare(`UPDATE grabbit_dedupe_journal SET state = 'restored', done_at = datetime('now') WHERE id = ?`).run(row.id);
  } catch (e) {
    throw mayHaveChanged(`The original is back but TikShortis could not record it (${(e as Error).message}); try the restore again`, row.id, row.uid);
  }
  return { id: row.id, restored: `${row.channel}/${row.drop_key}` };
}

// A clip name (the keeper's or the merged clip's) that still holds the
// merged bytes, hashed now. The stat is taken after the hash. null if none.
async function survivorOf(ctx: Ctx, row: JournalRow): Promise<{ abs: string; st: fs.Stats } | null> {
  for (const key of [row.keep_key, row.drop_key]) {
    let p: ReturnType<typeof parsePath>;
    try { p = parsePath(ctx, `${row.channel}/${key}`); } catch { continue; }
    let st0: fs.Stats;
    try { st0 = regular(p.abs, p.dir); } catch { continue; }
    let h: string;
    try { h = await sha256Of(p.abs); } catch { continue; }
    let st: fs.Stats;
    try { st = fs.lstatSync(p.abs); } catch { continue; }
    if (h !== row.sha256 || !st.isFile() || st.dev !== st0.dev || st.ino !== st0.ino || st.size !== st0.size || st.mtimeMs !== st0.mtimeMs) continue;
    return { abs: p.abs, st };
  }
  return null;
}

export async function purge(ctx: Ctx, id: unknown, uid: unknown) {
  const first = journal(ctx, id, uid, "purge");
  if (first.replay) return { id: first.id, bytes: first.purged_bytes ?? 0 };
  // The held original goes for good only while a clip still has its bytes:
  // the keeper (or the merged clip's name) is hashed first. A merge whose
  // clips were both removed or changed keeps its held original.
  // (A held name that is already gone has nothing left to lose.)
  let heldThere = true;
  try {
    fs.lstatSync(path.join(ctx.shortsRoot, first.channel, TRASH_DIR, first.trash_name as string));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    heldThere = false;
  }
  const survivor = heldThere ? await survivorOf(ctx, first) : null;
  if (heldThere && !survivor) {
    throw new DedupeError("No clip has these bytes any more, so the held original is the last copy; nothing was deleted", 409, "Restore it in Grabbit if the clip is still needed.");
  }
  // The hash took time: a restore may have finished this row meanwhile.
  const row = journal(ctx, id, uid, "purge");
  if (row.replay || row.state !== first.state || row.held_action !== first.held_action) {
    throw new DedupeError("This merge changed while the delete was checked; nothing was deleted, try again", 409);
  }
  const trashAbs = path.join(ctx.shortsRoot, row.channel, TRASH_DIR, row.trash_name as string);
  let bytes = 0;
  let unlinked = false;
  // A restore had started removing the held name: the original is back in
  // the clip, so a missing held name is no finished delete.
  if (row.held_action === "restore") {
    let present = true;
    try {
      fs.lstatSync(trashAbs);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      present = false;
    }
    if (!present) {
      throw new DedupeError("A restore of this merge was under way, so its original is back in the clip; nothing changed", 409, "Restore it again to finish the restore.");
    }
  }
  try {
    const st0 = fs.lstatSync(trashAbs);
    if (!st0.isFile()) throw new DedupeError("The held original is not a file");
    if (!heldMatches(row, trashAbs)) throw new DedupeError(HELD_REPLACED, 409, "Check the trash folder by hand in TikShortis.");
    // On record before the held name goes (see restore). The write can
    // block, so the held name is checked again after it, and the unlink
    // follows that check with nothing slow in between.
    try {
      ctx.db.prepare(`UPDATE grabbit_dedupe_journal SET held_action = 'purge' WHERE id = ?`).run(row.id);
    } catch (e) {
      throw new DedupeError(`TikShortis could not record the delete (${(e as Error).message}); nothing changed`, 422);
    }
    const st = fs.lstatSync(trashAbs);
    if (!st.isFile() || st.dev !== st0.dev || st.ino !== st0.ino || !heldMatches(row, trashAbs)) {
      throw new DedupeError(HELD_REPLACED, 409, "Check the trash folder by hand in TikShortis.");
    }
    // The held name came back or appeared after the first look: no
    // survivor was checked for it, so it stays.
    if (!survivor) throw new DedupeError("The held original changed while the delete was checked; nothing was deleted, try again", 409);
    let sv: fs.Stats | null = null;
    try { sv = fs.lstatSync(survivor.abs); } catch { sv = null; }
    if (!sv || !sv.isFile() || sv.dev !== survivor.st.dev || sv.ino !== survivor.st.ino || sv.size !== survivor.st.size || sv.mtimeMs !== survivor.st.mtimeMs) {
      throw new DedupeError("The clip that keeps these bytes changed meanwhile; nothing was deleted, try again", 409);
    }
    // Freed only if no live name shares it (the clip's own name was replaced
    // by the link, so normally nlink is 1 here).
    bytes = st.nlink === 1 ? st.size : 0;
    fs.unlinkSync(trashAbs);
    unlinked = true;
  } catch (e) {
    if (e instanceof DedupeError) throw e;
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  // A hold's poster frame goes with it, without a survivor check: it is a
  // frame made from the video, and the twin clip has its own. Only the inode
  // the hold put there is removed.
  if (row.kind === "hold") {
    try {
      const p = removeHeldPoster(ctx, row);
      bytes += p.bytes;
      if (p.removed) unlinked = true;
    } catch (e) {
      const msg = `TikShortis could not delete the held poster frame (${(e as NodeJS.ErrnoException).code || (e as Error).message}); try the purge again`;
      if (unlinked) throw mayHaveChanged(msg, row.id, row.uid);
      throw new DedupeError(msg, 422);
    }
  }
  // The removal must be on disk before the journal says purged: otherwise a
  // power loss could bring the held name back under a row that every retry
  // answers as done. Also on a retry that finds the name already gone.
  try {
    syncDir(path.dirname(trashAbs));
  } catch (e) {
    // No trash folder at all: the held name certainly is not coming back.
    const noFolder = !unlinked && (e as NodeJS.ErrnoException).code === "ENOENT";
    if (!noFolder) {
      const msg = `TikShortis could not confirm the delete on disk (${(e as NodeJS.ErrnoException).code || (e as Error).message}); try the purge again`;
      if (unlinked) throw mayHaveChanged(msg, row.id, row.uid);
      throw new DedupeError(msg, 422);
    }
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

// ---------------------------------------------------------------------------
// hold: a file no clip uses
//
// Grabbit finds files in this library whose bytes a live clip has too, but
// which no clip names (old double imports left them behind). Such a file is
// not a post, so a link would be wrong; it can only go. It goes the safe way:
// into the dedupe trash under the same journal as a merge, restorable until
// Grabbit's owner empties the trash, and purgeable only while the twin clip
// still has the bytes.
//
// What makes a file "no clip's", checked before and again right before it
// moves:
// - no shorts row names it, deleted rows and both sections included (a
//   deleted clip may be restored), as video or poster;
// - no row names a file with the same base name: the transcoder writes
//   <uuid>.web.mp4 and <uuid>.jpg before it points the row at them;
// - no open journal row names it;
// - it is older than HOLD_MIN_AGE_MS, by mtime, ctime and birth time: imports
//   (downloadOne, uploads) write the file before they insert the row.
// ---------------------------------------------------------------------------

export const HOLD_MIN_AGE_MS = 24 * 60 * 60 * 1000;

// "alice/x.web.mp4" -> "alice/x" (".web.mp4" counts as one extension).
function stemKey(key: string): string {
  if (key.toLowerCase().endsWith(".web.mp4")) return key.slice(0, -".web.mp4".length);
  const ext = path.posix.extname(key);
  return ext ? key.slice(0, -ext.length) : key;
}

const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv)$/i;

function likePrefix(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`) + "%";
}

// Why `key` is not an orphan, or null if it is one. Synchronous, so it can
// run right before the move with nothing slow after it.
function notOrphan(ctx: Ctx, channel: Channel, key: string, st: fs.Stats, minAge: number, selfId = 0): string | null {
  // Every section: a key is relative to its section's folder, so a row in the
  // other section names another file; refusing it too is the safe side.
  if (ctx.db.prepare("SELECT 1 FROM shorts WHERE storage_key = ? OR poster_key = ? LIMIT 1").get(key, key)) {
    return "A clip uses this file (a deleted clip counts too: it can be restored)";
  }
  const stem = stemKey(key).toLowerCase();
  const like = likePrefix(stemKey(key));
  const near = ctx.db
    .prepare("SELECT storage_key, poster_key FROM shorts WHERE storage_key LIKE ? ESCAPE '\\' OR poster_key LIKE ? ESCAPE '\\'")
    .all(like, like) as { storage_key: string | null; poster_key: string | null }[];
  if (near.some((r) => [r.storage_key, r.poster_key].some((k) => k != null && stemKey(k).toLowerCase() === stem))) {
    return "A clip uses a file with the same name (the transcoder may be about to point it at this one)";
  }
  if (
    ctx.db
      .prepare("SELECT 1 FROM grabbit_dedupe_journal WHERE channel = ? AND id != ? AND state IN ('pending', 'linked') AND (keep_key = ? OR drop_key = ? OR poster_key = ?) LIMIT 1")
      .get(channel, selfId, key, key, key)
  ) {
    return "Another Grabbit merge or hold still names this file";
  }
  const now = ctx.now ? ctx.now() : Date.now();
  const born = Math.max(st.mtimeMs, st.ctimeMs, st.birthtimeMs || 0);
  if (now - born < minAge) {
    return "The file is too new to be a leftover (an import may still be writing its clip)";
  }
  return null;
}

function sameFile(a: fs.Stats | null, b: fs.Stats): boolean {
  return !!a && a.isFile() && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

function lstatOrNull(abs: string): fs.Stats | null {
  try {
    return fs.lstatSync(abs);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

// Moves the live name `abs` to the fresh trash name `heldAbs` (a random name
// no one else knows, so the rename clobbers nothing), then judges what was
// moved. Anything other than `want` goes back with a no-clobber link.
// "held": `want` is at heldAbs. "back": something else was there and went
// back. "stuck": something else was moved and could not go back (it stays at
// heldAbs; the row must stay restorable).
function moveToHeld(abs: string, heldAbs: string, want: fs.Stats): "held" | "back" | "stuck" {
  fs.renameSync(abs, heldAbs);
  let got: fs.Stats | null = null;
  try { got = fs.lstatSync(heldAbs); } catch { got = null; }
  if (sameFile(got, want)) return "held";
  putBack(heldAbs, abs);
  return lstatOrNull(heldAbs) ? "stuck" : "back";
}

type HoldBody = { path?: unknown; twin?: unknown; sha256?: unknown; op?: unknown };

export async function hold(ctx: Ctx, body: HoldBody) {
  return withOp(ctx, body.op, (op) => holdFile(ctx, body, op));
}

async function holdFile(ctx: Ctx, body: HoldBody, op: string | null) {
  const file = parsePath(ctx, body.path);
  const twin = parsePath(ctx, body.twin);
  const sha = typeof body.sha256 === "string" && /^[0-9a-f]{64}$/.test(body.sha256) ? body.sha256 : null;
  if (!sha) throw new DedupeError("sha256 is required", 400);
  if (twin.channel !== file.channel) throw new DedupeError("The file and its twin are in different sections (main and 18+)");
  if (twin.abs === file.abs) throw new DedupeError("Choose two different files");
  const minAge = ctx.holdMinAgeMs ?? HOLD_MIN_AGE_MS;
  // The twin keeps the bytes: purge later deletes the held file only while
  // a clip still has them, so the twin must be a live clip's file.
  const twinRefs = refsOf(ctx.db, twin.channel, twin.key);
  if (!twinRefs.length) throw new DedupeError("No clip uses the twin file, so this file may be the last copy; nothing changed");
  if (busy) throw new DedupeError("Another merge is running; try again in a moment");
  busy = true;
  try {
    const fs0 = regular(file.abs, file.dir);
    const ts = regular(twin.abs, twin.dir);
    const why = notOrphan(ctx, file.channel, file.key, fs0, minAge);
    if (why) throw new DedupeError(`${why}; nothing changed`);
    if (fs0.size !== ts.size) throw new DedupeError("The files are not identical any more; scan again");
    const [a, b] = await Promise.all([sha256Of(file.abs), sha256Of(twin.abs)]);
    if (a !== sha || b !== sha) throw new DedupeError("The bytes no longer match what Grabbit saw; scan again");
    if (!sameFile(lstatOrNull(file.abs), fs0) || !sameFile(lstatOrNull(twin.abs), ts)) {
      throw new DedupeError("A file changed while it was checked; try again");
    }
    if (!refsOf(ctx.db, twin.channel, twin.key).length) throw new DedupeError("The twin clip changed while it was checked; scan again");
    // The poster frame beside a video (<stem>.jpg) goes with it when it is
    // an orphan too. A poster that is not stays where it is.
    let poster: { key: string; abs: string; st: fs.Stats } | null = null;
    if (VIDEO_EXT.test(file.key)) {
      const pkey = `${stemKey(file.key)}.jpg`;
      try {
        const p = parsePath(ctx, `${file.channel}/${pkey}`);
        const ps = regular(p.abs, p.dir);
        if (!notOrphan(ctx, file.channel, pkey, ps, minAge)) poster = { key: pkey, abs: p.abs, st: ps };
      } catch { poster = null; }
    }
    const uid = crypto.randomBytes(16).toString("hex");
    const held = identity(file.abs);
    const id = ctx.db.transaction(() => {
      const jid = Number(
        ctx.db
          .prepare(
            `INSERT INTO grabbit_dedupe_journal (channel, keep_key, drop_key, role, sha256, bytes, state, uid, drop_refs, kind, held_dev, held_ino, poster_key)
             VALUES (?, ?, ?, 'orphan', ?, ?, 'pending', ?, '[]', 'hold', ?, ?, ?)`
          )
          .run(file.channel, twin.key, file.key, sha, fs0.size, uid, held.dev, held.ino, poster ? poster.key : null).lastInsertRowid
      );
      if (op && ctx.db.prepare("UPDATE grabbit_dedupe_ops SET journal_id = ? WHERE op = ? AND state = 'started'").run(jid, op).changes !== 1) {
        throw new DedupeError("This request was closed meanwhile; nothing changed", 409);
      }
      return jid;
    })();
    const trashDir = path.join(file.dir, TRASH_DIR);
    const trashName = `${id}-${crypto.randomBytes(4).toString("hex")}-${path.basename(file.key).slice(0, 150)}`;
    const trashAbs = path.join(trashDir, trashName);
    // On record before any file moves, so an interrupted hold can be
    // restored or purged.
    ctx.db.prepare(`UPDATE grabbit_dedupe_journal SET trash_name = ? WHERE id = ?`).run(trashName, id);
    const failRow = (e: unknown) => {
      try {
        ctx.db.prepare(`UPDATE grabbit_dedupe_journal SET state = 'failed', error = ?, done_at = datetime('now') WHERE id = ? AND state = 'pending'`).run(String((e as Error).message).slice(0, 300), id);
      } catch { /* stays pending: restore and opstatus still work */ }
    };
    let moved: "held" | "back" | "stuck" | null = null;
    try {
      fs.mkdirSync(trashDir, { recursive: true });
      syncDir(trashDir);
      syncDir(file.dir);
      // The last checks, with nothing slow between them and the rename.
      const why2 = notOrphan(ctx, file.channel, file.key, fs0, minAge, id);
      if (why2) throw new DedupeError(`${why2}; nothing changed`);
      const nowId = identity(file.abs);
      if (!sameFile(lstatOrNull(file.abs), fs0) || nowId.dev !== held.dev || nowId.ino !== held.ino) {
        throw new DedupeError("The file changed while the hold was prepared; nothing changed");
      }
      moved = moveToHeld(file.abs, trashAbs, fs0);
    } catch (e) {
      // A rename that happened but could not be judged: the moved file, if
      // any, is at the recorded trash name, so the row stays pending and
      // restorable. A trash name that cannot be checked counts as present.
      let atTrash = true;
      try { atTrash = !!lstatOrNull(trashAbs); } catch { atTrash = true; }
      if (moved === null && atTrash) {
        throw mayHaveChanged(`TikShortis could not finish the hold (${(e as NodeJS.ErrnoException).code || (e as Error).message}); hold ${id} is pending and can be restored`, id, uid);
      }
      failRow(e);
      if (e instanceof DedupeError) throw e;
      throw new DedupeError(`TikShortis could not hold the file (${(e as NodeJS.ErrnoException).code || (e as Error).message}); nothing changed`);
    }
    if (moved === "back") {
      const e = new DedupeError("The file changed while the hold was prepared; nothing changed");
      failRow(e);
      throw e;
    }
    if (moved === "stuck") {
      throw mayHaveChanged(`Another file took this name while it was held; it stays in TikShortis' dedupe trash as hold ${id} and can be restored`, id, uid);
    }
    // The video is held. Its poster follows; a poster that changed meanwhile
    // stays where it is (it is not this hold's any more).
    let posterHeld = false;
    if (poster) {
      const pName = `${id}-${crypto.randomBytes(4).toString("hex")}-${path.basename(poster.key).slice(0, 150)}`;
      const pAbs = path.join(trashDir, pName);
      try {
        const pid = identity(poster.abs);
        ctx.db.prepare(`UPDATE grabbit_dedupe_journal SET poster_trash = ?, poster_dev = ?, poster_ino = ? WHERE id = ?`).run(pName, pid.dev, pid.ino, id);
        if (!notOrphan(ctx, file.channel, poster.key, poster.st, minAge, id) && sameFile(lstatOrNull(poster.abs), poster.st)) {
          const pm = moveToHeld(poster.abs, pAbs, poster.st);
          posterHeld = pm === "held";
          if (pm === "stuck") console.error(`[grabbit-dedupe] hold ${id}: another file took ${poster.key} while it was held; it stays at ${pAbs}`);
        }
      } catch (e) {
        console.error(`[grabbit-dedupe] hold ${id}: the poster frame stays where it is (${(e as NodeJS.ErrnoException).code || (e as Error).message})`);
      }
      if (!posterHeld && !lstatOrNull(pAbs)) {
        try {
          ctx.db.prepare(`UPDATE grabbit_dedupe_journal SET poster_key = NULL, poster_trash = NULL, poster_dev = NULL, poster_ino = NULL WHERE id = ?`).run(id);
        } catch { /* restore and purge find no held poster and skip it */ }
      }
    }
    let durable = true;
    try {
      syncDir(trashDir);
      syncDir(path.dirname(file.abs));
    } catch (e) {
      durable = false;
      console.error(`[grabbit-dedupe] hold ${id}: a folder could not be synced (${(e as NodeJS.ErrnoException).code || (e as Error).message})`);
    }
    try {
      ctx.db.prepare(`UPDATE grabbit_dedupe_journal SET state = 'linked', error = ?, done_at = datetime('now') WHERE id = ?`).run(durable ? null : "folder sync failed", id);
    } catch (e) {
      throw mayHaveChanged(`TikShortis held the file but could not record it (${(e as Error).message}); hold ${id} is pending and can be restored`, id, uid);
    }
    return {
      id,
      uid,
      bytes: fs0.size,
      posts: [] as number[],
      held: `${file.channel}/${file.key}`,
      poster: posterHeld && poster ? `${file.channel}/${poster.key}` : null,
      durable,
    };
  } finally {
    busy = false;
  }
}

// The held poster frame of a hold row, if the row has one.
function heldPoster(ctx: Ctx, row: JournalRow): { abs: string; key: string } | null {
  if (row.kind !== "hold" || !row.poster_trash || !row.poster_key || row.poster_trash !== path.basename(row.poster_trash)) return null;
  return { abs: path.join(ctx.shortsRoot, row.channel, TRASH_DIR, row.poster_trash), key: row.poster_key };
}

function posterIdentityOk(row: JournalRow, abs: string): boolean {
  if (row.poster_dev == null || row.poster_ino == null) return false;
  const now = identity(abs);
  return now.dev === row.poster_dev && now.ino === row.poster_ino;
}

// Purge: removes the held poster if it is still the inode the hold put
// there. Returns the bytes freed and whether a name was removed.
function removeHeldPoster(ctx: Ctx, row: JournalRow): { bytes: number; removed: boolean } {
  const hp = heldPoster(ctx, row);
  if (!hp) return { bytes: 0, removed: false };
  const st = lstatOrNull(hp.abs);
  if (!st || !st.isFile() || !posterIdentityOk(row, hp.abs)) return { bytes: 0, removed: false };
  const bytes = st.nlink === 1 ? st.size : 0;
  return removeHeld(hp.abs, st) === "removed" ? { bytes, removed: true } : { bytes: 0, removed: false };
}

// Puts a held file back at its name: a no-clobber link, refused when another
// file has the name or a clip names it (a clip without its file would get
// bytes that are not its own). "back" if the name holds the held inode now.
function putHeldBack(ctx: Ctx, channel: Channel, key: string, heldAbs: string, held: fs.Stats): "back" | "taken" {
  const dir = path.join(ctx.shortsRoot, channel);
  const t = parsePath(ctx, `${channel}/${key}`);
  const cur = lstatOrNull(t.abs);
  if (cur) return cur.dev === held.dev && cur.ino === held.ino ? "back" : "taken";
  if (ctx.db.prepare("SELECT 1 FROM shorts WHERE storage_key = ? OR poster_key = ? LIMIT 1").get(key, key)) return "taken";
  checkParents(dir, t.abs, true);
  fs.mkdirSync(path.dirname(t.abs), { recursive: true });
  checkParents(dir, t.abs, false);
  try {
    fs.linkSync(heldAbs, t.abs);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return "taken";
    throw e;
  }
  const now = lstatOrNull(t.abs);
  return now && now.dev === held.dev && now.ino === held.ino ? "back" : "taken";
}

function restoreHold(ctx: Ctx, row: JournalRow) {
  const dir = path.join(ctx.shortsRoot, row.channel);
  const file = parsePath(ctx, `${row.channel}/${row.drop_key}`);
  const trashAbs = path.join(dir, TRASH_DIR, row.trash_name as string);
  const answer = (poster: string | null) => ({ id: row.id, restored: `${row.channel}/${row.drop_key}`, poster });
  let held: fs.Stats | null;
  try {
    held = lstatOrNull(trashAbs);
  } catch (e) {
    throw new DedupeError(`The held file cannot be checked (${(e as NodeJS.ErrnoException).code || (e as Error).message}); nothing changed`);
  }
  if (!held) {
    if (row.held_action === "purge") {
      throw new DedupeError("A delete of this held file was under way; nothing changed", 409, "Delete it again to finish the delete.");
    }
    // A restore that put the file back and removed its held name but could
    // not record it: the name holds the held inode.
    let back = false;
    try {
      const now = identity(file.abs);
      back = row.held_dev != null && now.dev === row.held_dev && now.ino === row.held_ino;
    } catch { back = false; }
    if (!back) throw new DedupeError("The held file is missing");
    try {
      ctx.db.prepare(`UPDATE grabbit_dedupe_journal SET state = 'restored', done_at = datetime('now') WHERE id = ?`).run(row.id);
    } catch (e) {
      throw mayHaveChanged(`The file is back but TikShortis could not record it (${(e as Error).message}); try the restore again`, row.id, row.uid);
    }
    return answer(null);
  }
  if (!held.isFile()) throw new DedupeError("The held file is not a file");
  // Whatever is at the held name came from the file's name (the trash name
  // is random and on record before the move), so it is what goes back, also
  // when a pending hold moved a writer's file there.
  const r = putHeldBack(ctx, row.channel, row.drop_key, trashAbs, held);
  if (r === "taken") {
    throw new DedupeError(
      "Another file or a clip uses this name now; restoring would overwrite or stand in for it, so nothing changed",
      409,
      "Delete the held file instead, or restore it by hand."
    );
  }
  // The poster frame goes back when it can; a poster name taken meanwhile
  // leaves the held poster for the purge.
  const hp = heldPoster(ctx, row);
  let posterBack: { abs: string; st: fs.Stats; key: string } | null = null;
  if (hp) {
    try {
      const pst = lstatOrNull(hp.abs);
      if (pst && pst.isFile() && putHeldBack(ctx, row.channel, hp.key, hp.abs, pst) === "back") posterBack = { abs: hp.abs, st: pst, key: hp.key };
    } catch (e) {
      console.error(`[grabbit-dedupe] hold ${row.id}: the poster frame stays held (${(e as NodeJS.ErrnoException).code || (e as Error).message})`);
    }
  }
  try {
    syncUp(path.dirname(file.abs), dir);
  } catch (e) {
    throw mayHaveChanged(
      `TikShortis put the file back but could not confirm it on disk (${(e as NodeJS.ErrnoException).code || (e as Error).message}); the held file is kept, try the restore again`,
      row.id,
      row.uid
    );
  }
  try {
    ctx.db.prepare(`UPDATE grabbit_dedupe_journal SET held_action = 'restore' WHERE id = ?`).run(row.id);
  } catch (e) {
    throw mayHaveChanged(`TikShortis put the file back but could not record it (${(e as Error).message}); the held file is kept, try the restore again`, row.id, row.uid);
  }
  // The held name is a second name of the restored file now. It goes only
  // while the file's name still holds it (removeHeld checks the held name).
  const still = lstatOrNull(file.abs);
  if (!still || still.dev !== held.dev || still.ino !== held.ino) {
    throw mayHaveChanged("The file was replaced while it was being restored; the held file is kept", row.id, row.uid);
  }
  try {
    removeHeld(trashAbs, held);
    if (posterBack) {
      const pNow = lstatOrNull(path.join(dir, posterBack.key));
      if (pNow && pNow.dev === posterBack.st.dev && pNow.ino === posterBack.st.ino) removeHeld(posterBack.abs, posterBack.st);
    }
  } catch (e) {
    throw mayHaveChanged(
      `The file is back, but TikShortis could not remove its held copy (${(e as NodeJS.ErrnoException).code || (e as Error).message}); try the restore again`,
      row.id,
      row.uid
    );
  }
  try {
    ctx.db.prepare(`UPDATE grabbit_dedupe_journal SET state = 'restored', done_at = datetime('now') WHERE id = ?`).run(row.id);
  } catch (e) {
    throw mayHaveChanged(`The file is back but TikShortis could not record it (${(e as Error).message}); try the restore again`, row.id, row.uid);
  }
  return answer(posterBack ? `${row.channel}/${posterBack.key}` : null);
}

// A pending hold whose call is not running any more:
// - no held name and the file's name still holds the recorded inode: the
//   move never happened -> 'failed';
// - the held name holds the recorded inode with the journaled bytes and the
//   file's name is free: the hold finished but was not recorded -> 'linked';
// - anything else stays 'pending' (restore still works on it).
async function reconcileHold(ctx: Ctx, row: JournalRow): Promise<string> {
  try {
    const file = parsePath(ctx, `${row.channel}/${row.drop_key}`);
    const trashAbs = row.trash_name && row.trash_name === path.basename(row.trash_name)
      ? path.join(ctx.shortsRoot, row.channel, TRASH_DIR, row.trash_name)
      : null;
    const d = lstatOrNull(file.abs);
    const h = trashAbs ? lstatOrNull(trashAbs) : null;
    const isHeldInode = (abs: string) => {
      const n = identity(abs);
      return row.held_dev != null && n.dev === row.held_dev && n.ino === row.held_ino;
    };
    const set = (state: "failed" | "linked", why: string) => {
      ctx.db.prepare(`UPDATE grabbit_dedupe_journal SET state = ?, error = ?, done_at = datetime('now') WHERE id = ? AND state = 'pending'`).run(state, why, row.id);
      return state;
    };
    if (!h) {
      if (d && d.isFile() && isHeldInode(file.abs) && !heldPoster(ctx, row)) return set("failed", "stopped before the file moved");
      return "pending";
    }
    if (d || !h.isFile() || !isHeldInode(trashAbs as string)) return "pending";
    const hh = await sha256Of(trashAbs as string);
    if (hh !== row.sha256 || busy) return "pending";
    const cur = ctx.db.prepare(`SELECT state FROM grabbit_dedupe_journal WHERE id = ?`).get(row.id) as { state: string } | undefined;
    if (!cur || cur.state !== "pending") return cur ? cur.state : "pending";
    if (!sameFile(lstatOrNull(trashAbs as string), h) || lstatOrNull(file.abs)) return "pending";
    return set("linked", "finished before a stop, recorded later");
  } catch {
    return "pending";
  }
}

export function status(ctx: Ctx) {
  ensureJournal(ctx.db);
  const rows = ctx.db.prepare(`SELECT state, COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS bytes FROM grabbit_dedupe_journal GROUP BY state`).all();
  return { version: 1, journal: rows };
}
