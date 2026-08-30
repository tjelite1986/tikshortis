import { db, ShortChannel } from "./db";
import { qb, getOne } from "./kysely";
import { CHANNEL, getAliasProfileId } from "./shorts";

/**
 * The creator profile a name belongs to, creating it if this is the first time
 * the name has been seen.
 *
 * Names are stored lowercase, and a handle that has been merged away routes to
 * the profile that survived the merge — so re-importing a folder named after an
 * old handle lands on the current profile instead of resurrecting the duplicate
 * that was just merged. A profile created here is `manual`: it has no poll
 * source, because whatever created it (an import folder, an upload) is the
 * thing that will keep feeding it.
 */
export function findOrCreateShortProfile(
  name: string,
  channel: ShortChannel = CHANNEL
): number {
  const lname = name.toLowerCase();
  const aliased = getAliasProfileId(channel, lname);
  if (aliased) return aliased;
  const row = getOne<{ id: number }>(
    qb
      .selectFrom("short_profiles")
      .select("id")
      .where("channel", "=", channel)
      .where("name", "=", lname)
  );
  if (row) return row.id;
  return Number(
    db
      .prepare(
        `INSERT INTO short_profiles
           (name, channel, source_type, source_ref, auto_poll, videos_limit)
         VALUES (?, ?, 'manual', '', 0, 20)`
      )
      .run(lname, channel).lastInsertRowid
  );
}
