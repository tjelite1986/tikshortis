import { db } from "./db";

/**
 * Who a handle refers to.
 *
 * elite-v2 answered this with a graph across three modules — a person could be
 * a user account, a post creator and one or more shorts profiles, tied together
 * by a `profile_links` table, and every shorts query had to expand a handle
 * through all of it. Here there are only two kinds of face, a shorts profile and
 * an account, so the graph collapses to the merge this app already records:
 * `short_profile_aliases`, written when an admin merges two handles for the same
 * creator into one profile.
 */

// Stored names are display-ish (imports keep the creator's own capitalisation
// and punctuation), so every comparison runs through this.
export function handleOf(name: string): string {
  return String(name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._]+/g, "")
    .replace(/^[._]+|[._]+$/g, "");
}

// Registered as a SQL function so SQLite can filter on the normalised form
// without materialising every profile row in JS.
db.function("norm_handle", { deterministic: true }, (s: unknown) =>
  handleOf(String(s ?? ""))
);

/**
 * Every handle that resolves to the same creator: the one asked for, plus each
 * name that has been merged into the profile it names (and that profile's own
 * name, when the handle asked for is itself a merged-away alias).
 */
export function getGroupMembers(handle: string): string[] {
  const h = handleOf(handle);
  if (!h) return [];
  const members = new Set<string>([h]);

  // The profile this handle names, either directly or through an alias.
  const profiles = db
    .prepare(
      `SELECT id, name FROM short_profiles WHERE norm_handle(name) = ?
       UNION
       SELECT p.id, p.name FROM short_profiles p
         JOIN short_profile_aliases a ON a.profile_id = p.id
        WHERE norm_handle(a.name) = ?`
    )
    .all(h, h) as { id: number; name: string }[];

  for (const p of profiles) {
    members.add(handleOf(p.name));
    const aliases = db
      .prepare("SELECT name FROM short_profile_aliases WHERE profile_id = ?")
      .all(p.id) as { name: string }[];
    for (const a of aliases) members.add(handleOf(a.name));
  }
  return [...members].filter(Boolean);
}

export interface PersonContentIds {
  /** Accounts whose own uploads belong to this person. */
  userIds: number[];
  /** Creator profiles clips are filed under. */
  shortsIds: number[];
}

/**
 * The ids a handle's clips can be filed under. An empty result means "nobody" —
 * callers must never read it as "no filter" and fall through to browsing the
 * whole library.
 */
export function personContentIds(handle: string): PersonContentIds {
  const members = getGroupMembers(handle);
  if (members.length === 0) return { userIds: [], shortsIds: [] };
  const ph = members.map(() => "?").join(", ");

  const userIds = (
    db
      .prepare(
        `SELECT id FROM users WHERE norm_handle(COALESCE(username, '')) IN (${ph})`
      )
      .all(...members) as { id: number }[]
  ).map((r) => r.id);

  const shortsIds = (
    db
      .prepare(
        `SELECT id FROM short_profiles WHERE norm_handle(name) IN (${ph})`
      )
      .all(...members) as { id: number }[]
  ).map((r) => r.id);

  return { userIds, shortsIds };
}
