import { Kysely, SqliteDialect, type Compilable } from "kysely";
import {
  db as sqlite,
  type UserRow,
  type UserPermissionRow,
  type ShortRow,
  type ShortLikeRow,
  type ShortCommentRow,
  type ShortDupeGroupRow,
  type ShortDupeStateRow,
  type ShortTitleStateRow,
  type ShortCaptionStateRow,
  type ShortProfileRow,
  type ShortProfileAliasRow,
  type ShortPlaylistRow,
  type ShortPlaylistItemRow,
  type FollowRow,
  type MediaFpRow,
  type ShortDupeDismissalRow,
} from "./db";

// The table map is built from the row interfaces in db.ts (which are updated
// with every migration) so there is no second source of truth, and the literal
// unions (ShortChannel, status, source, ...) carry over.
export interface DB {
  users: UserRow;
  user_permissions: UserPermissionRow;
  shorts: ShortRow;
  short_likes: ShortLikeRow;
  short_comments: ShortCommentRow;
  short_profiles: ShortProfileRow;
  short_profile_aliases: ShortProfileAliasRow;
  short_playlists: ShortPlaylistRow;
  short_playlist_items: ShortPlaylistItemRow;
  short_dupe_groups: ShortDupeGroupRow;
  short_dupe_state: ShortDupeStateRow;
  short_title_state: ShortTitleStateRow;
  short_caption_state: ShortCaptionStateRow;
  short_media_fp: MediaFpRow;
  short_dupe_dismissals: ShortDupeDismissalRow;
  follows: FollowRow;
}

// Kysely is used ONLY to build and type-check queries. Execution stays
// synchronous through the existing better-sqlite3 connection (same WAL, same
// singleton), so the data layer is sync and no caller has to become async.
// Kysely never drives the dialect (.execute() is never called); the dialect
// database is only here to satisfy the constructor.
export const qb = new Kysely<DB>({
  dialect: new SqliteDialect({ database: sqlite }),
});

// Compile a SELECT and run it synchronously via better-sqlite3.
export function getOne<T>(query: Compilable<unknown>): T | undefined {
  const { sql, parameters } = query.compile();
  return sqlite.prepare(sql).get(...(parameters as unknown[])) as T | undefined;
}

export function getAll<T>(query: Compilable<unknown>): T[] {
  const { sql, parameters } = query.compile();
  return sqlite.prepare(sql).all(...(parameters as unknown[])) as T[];
}

// Compile an INSERT/UPDATE/DELETE and run it synchronously. Returns the
// better-sqlite3 result (lastInsertRowid, changes).
export function runSync(query: Compilable<unknown>) {
  const { sql, parameters } = query.compile();
  return sqlite.prepare(sql).run(...(parameters as unknown[]));
}
