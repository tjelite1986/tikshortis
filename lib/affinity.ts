import { db } from "./db";
import { parseHashtags } from "./import-naming";
import { followedShortsScope } from "./shorts";
import { viewHistory } from "./views";

/**
 * What one viewer has shown they like, as weights per creator and per hashtag.
 *
 * Every signal the app already records counts, plus the watch history: a
 * follow or a save says more than a like, a like more than watching to the
 * end, and a clip skipped after a couple of seconds counts against its creator
 * and tags. Weights are summed per creator profile (or uploader, for user
 * uploads) and per tag, then squashed in the ranker so one creator with fifty
 * likes does not drown everything else.
 */
export interface Affinity {
  /** key: "p:<profile_id>" or "u:<uploader_id>" */
  creators: Map<string, number>;
  tags: Map<string, number>;
  /** How much evidence there is at all; below a few points the feed is cold. */
  evidence: number;
  /** Creators the viewer follows, for the "you follow" reason. */
  followed: Set<string>;
  /** Creator keys the viewer has watched anything from. */
  seenCreators: Set<string>;
}

const W = {
  follow: 6,
  save: 4,
  like: 3,
  comment: 3,
  completed: 1,
  watchedHalf: 0.5,
  skipped: -0.7,
  hide: -6,
  // Tag weights are a share of the creator weight: a tag is one of several
  // on the clip and says less about taste than who made it.
  tagShare: 0.4,
} as const;

/** Per-entity cap, so a long history saturates instead of dominating. */
const MAX_PER_KEY = 20;
const MIN_PER_KEY = -12;

type ClipFacts = {
  profile_id: number | null;
  uploader_id: number | null;
  caption: string | null;
  duration: number | null;
};

export function creatorKey(c: { profile_id: number | null; uploader_id: number | null }): string | null {
  if (c.profile_id !== null) return `p:${c.profile_id}`;
  if (c.uploader_id !== null) return `u:${c.uploader_id}`;
  return null;
}

export function computeAffinity(viewerId: number): Affinity {
  const creators = new Map<string, number>();
  const tags = new Map<string, number>();
  const seenCreators = new Set<string>();
  let evidence = 0;

  const bump = (map: Map<string, number>, key: string, w: number) => {
    const next = Math.max(MIN_PER_KEY, Math.min(MAX_PER_KEY, (map.get(key) ?? 0) + w));
    map.set(key, next);
  };
  const credit = (clip: ClipFacts, w: number) => {
    const ck = creatorKey(clip);
    if (ck) bump(creators, ck, w);
    const tagList = parseHashtags(clip.caption);
    for (const t of tagList) bump(tags, t, (w * W.tagShare) / Math.max(1, Math.sqrt(tagList.length)));
    if (w > 0) evidence += w;
  };

  const facts = (sql: string): ClipFacts[] =>
    db.prepare(sql).all(viewerId) as ClipFacts[];

  // Explicit signals.
  for (const c of facts(
    `SELECT s.profile_id, s.uploader_id, s.caption, s.duration
     FROM short_likes l JOIN shorts s ON s.id = l.short_id WHERE l.user_id = ?`
  )) {
    credit(c, W.like);
  }
  for (const c of facts(
    `SELECT DISTINCT s.profile_id, s.uploader_id, s.caption, s.duration
     FROM short_playlist_items pi
     JOIN short_playlists pl ON pl.id = pi.playlist_id
     JOIN shorts s ON s.id = pi.short_id WHERE pl.user_id = ?`
  )) {
    credit(c, W.save);
  }
  for (const c of facts(
    `SELECT DISTINCT s.profile_id, s.uploader_id, s.caption, s.duration
     FROM short_comments c JOIN shorts s ON s.id = c.short_id WHERE c.user_id = ?`
  )) {
    credit(c, W.comment);
  }
  for (const c of facts(
    `SELECT s.profile_id, s.uploader_id, s.caption, s.duration
     FROM short_hides h JOIN shorts s ON s.id = h.short_id WHERE h.user_id = ?`
  )) {
    credit(c, W.hide);
  }

  // Follows: the scope already walks the person graph, so an alias of a
  // followed creator counts too.
  const followed = new Set<string>();
  const scope = followedShortsScope(viewerId);
  for (const id of scope.profileIds) {
    followed.add(`p:${id}`);
    bump(creators, `p:${id}`, W.follow);
    evidence += W.follow;
  }
  for (const id of scope.userIds) {
    followed.add(`u:${id}`);
    bump(creators, `u:${id}`, W.follow);
    evidence += W.follow;
  }

  // Watch history. Completed and half-watched count for; a short stretch on a
  // clip long enough to judge counts against, mildly.
  const history = viewHistory(viewerId);
  if (history.size) {
    const ids = [...history.keys()];
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const rows = db
        .prepare(
          `SELECT id, profile_id, uploader_id, caption, duration FROM shorts
           WHERE id IN (${chunk.map(() => "?").join(",")})`
        )
        .all(...chunk) as (ClipFacts & { id: number })[];
      for (const r of rows) {
        const ck = creatorKey(r);
        if (ck) seenCreators.add(ck);
        const h = history.get(r.id)!;
        const dur = r.duration ?? 0;
        const frac = dur > 0 ? h.watchMs / 1000 / dur : 0;
        if (h.completed) credit(r, W.completed);
        else if (frac >= 0.5) credit(r, W.watchedHalf);
        else if (dur >= 8 && h.watchMs < 3000) credit(r, W.skipped);
      }
    }
  }

  return { creators, tags, evidence, followed, seenCreators };
}
