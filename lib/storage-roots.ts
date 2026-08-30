import fs from "node:fs";
import path from "node:path";

// Single source of truth for storage roots and the per-user folder layout. In
// production each root is a bind-mounted host folder (see
// docker2/compose/tikshortis/docker-compose.yml); the defaults under DATA_DIR
// keep dev self-contained.
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");

// Permanent per-user content home: <PROFILE_ROOT>/u_<user>/shorts/...
// This tree is SHARED with elite-v2 — the storage keys migrated in already
// point into it, and moving 48 GB to prove a point would have been the
// expensive way to change nothing. Only the shorts subtree is touched here.
export const PROFILE_ROOT =
  process.env.PROFILE_ROOT || path.join(DATA_DIR, "profile");

// Staging area, deliberately SEPARATE from PROFILE_ROOT so the drop tree (where
// files are placed for ingest) never mixes with served storage:
//   <IMPORT_ROOT>/u_<user>/shorts/
export const IMPORT_ROOT =
  process.env.IMPORT_ROOT || path.join(DATA_DIR, "_import");

// Per-user permanent sections under PROFILE_ROOT/u_<user>/. elite-v2 provisions
// its own sections (gallery, posts, 18+, cookies) in the same tree; this app
// creates only the one it owns, so a folder here is never evidence about
// anything but shorts.
export const PROFILE_SECTIONS = ["shorts"] as const;

// Per-user drop sections under IMPORT_ROOT/u_<user>/.
export const IMPORT_SECTIONS = ["shorts"] as const;

// True when the directory exists and holds at least one entry. A production
// media root is a bind mount that always has content, so a missing or empty
// root almost certainly means the volume is not mounted — callers must not
// treat "file not found" as meaningful in that state (an orphan sweep would
// otherwise classify the whole library as deletable).
export function storageRootAvailable(dir: string): boolean {
  try {
    return fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}
