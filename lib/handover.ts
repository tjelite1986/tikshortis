import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { db } from "./db";
import { getShort } from "./shorts";
import { videoPathFor, posterPathFor } from "./shorts-storage";
import { parseImportName, parseHashtags } from "./import-naming";

/**
 * Hand a clip over to elite-v2's 18+ library.
 *
 * In elite-v2 this was a channel move: both libraries were rows in one table, so
 * the clip changed a column and its files moved to the other tree. The 18+ half
 * stayed behind in that app, so a move across is now a move across an
 * application boundary — and writing into another app's database from here would
 * make two apps owners of one schema.
 *
 * So the clip goes in the way every other clip goes in: dropped into elite-v2's
 * shorts import folder, named with the bracket grammar its importer parses, and
 * left for the timer that already watches that folder. The row here is
 * soft-deleted once the file is on the other side. The clip is invisible in both
 * apps for a few minutes — elite-v2's importer runs every 5 minutes and its
 * transcoder every 3 — which is the same lag any drop into that folder has.
 *
 * HANDOVER_18PLUS_DIR is the mounted drop folder. Unset means the feature is
 * simply not available (the menu row asks first), never a silent no-op.
 */

export function handoverConfigured(): boolean {
  return Boolean(process.env.HANDOVER_18PLUS_DIR);
}

// rename(2) fails with EXDEV between bind mounts — the drop folder is a
// different mount from both storage roots — so a cross-device move is a copy
// followed by an unlink. The unlink comes AFTER the copy is complete, so an
// interrupted handover leaves a duplicate rather than nothing.
function moveFile(src: string, dest: string) {
  try {
    fs.renameSync(src, dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    fs.copyFileSync(src, dest);
    fs.unlinkSync(src);
  }
}

function uniqueDest(dir: string, base: string): string {
  const dest = path.join(dir, base);
  if (!fs.existsSync(dest)) return dest;
  const ext = base.toLowerCase().endsWith(".web.mp4")
    ? ".web.mp4"
    : path.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  return path.join(dir, `${stem}_${randomUUID().slice(0, 8)}${ext}`);
}

/**
 * The name elite-v2's importer will read the clip's metadata back out of.
 *
 * The creator is written as `[f_<name>]` so the clip is filed under the same
 * handle on the other side, and the caption's hashtags survive as `[h_]`
 * tokens. `[id_]` is deliberately NOT this app's row id: over there it means a
 * row in ITS database, and handing it a foreign id would collide with whatever
 * clip already holds it. The clip arrives as new.
 */
function handoverName(
  caption: string | null,
  creator: string | null,
  originalKey: string
): string {
  const ext = originalKey.toLowerCase().endsWith(".web.mp4")
    ? ".mp4"
    : path.extname(originalKey) || ".mp4";
  const base = path.parse(originalKey).name.replace(/\.web$/i, "");
  const parsed = parseImportName(base);
  const title = (caption || parsed.title || base).split("\n")[0].slice(0, 80);
  const hashtags = Array.from(
    new Set([...parsed.hashtags, ...parseHashtags(caption)])
  );
  const clean = (s: string) =>
    s.replace(/[/:*?"<>|[\]\x00]+/g, " ").replace(/\s+/g, " ").trim();
  const tags = hashtags.map((t) => `[h_${t}]`).join("");
  const coll = creator ? `[f_${clean(creator)}]` : "";
  return `${clean(title) || "clip"} ${tags}${coll}`.trim() + ext;
}

export function handOverTo18Plus(
  shortId: number
): { ok: true } | { ok: false; error: string } {
  const dropDir = process.env.HANDOVER_18PLUS_DIR;
  if (!dropDir) {
    return { ok: false, error: "The 18+ library is not reachable from here." };
  }
  const short = getShort(shortId);
  if (!short) return { ok: false, error: "Not found" };

  const src = videoPathFor(short.channel, short.storage_key);
  if (!fs.existsSync(src)) {
    return { ok: false, error: "The clip's file is missing." };
  }

  const creator = short.profile_id
    ? (
        db
          .prepare("SELECT name FROM short_profiles WHERE id = ?")
          .get(short.profile_id) as { name: string } | undefined
      )?.name ?? null
    : null;

  fs.mkdirSync(dropDir, { recursive: true });
  const dest = uniqueDest(
    dropDir,
    handoverName(short.caption, creator, short.storage_key)
  );

  moveFile(src, dest);

  try {
    // The row goes only after the file has landed. A soft delete, not a purge:
    // the likes, comments and playlist entries that pointed at it stay readable,
    // and a handover that turns out to be a mistake is a row to un-flag rather
    // than a history to reconstruct.
    db.prepare("UPDATE shorts SET is_deleted = 1 WHERE id = ?").run(shortId);
  } catch (err) {
    // Put it back: a clip that is gone from disk but still listed here is the
    // one state neither app can recover from on its own.
    try {
      moveFile(dest, src);
    } catch {
      /* leave for the maintenance sweep to report */
    }
    throw err;
  }

  // The poster belongs to a row that no longer serves anything; elite-v2 makes
  // its own. Best effort — a leftover .jpg costs nothing and the sweep finds it.
  if (short.poster_key) {
    try {
      const poster = posterPathFor(short.channel, short.poster_key);
      if (fs.existsSync(poster)) fs.unlinkSync(poster);
    } catch {
      /* best effort */
    }
  }

  return { ok: true };
}
