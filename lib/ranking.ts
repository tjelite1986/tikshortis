import { computeAffinity, creatorKey, type Affinity, type Source } from "./affinity";
import { parseHashtags } from "./import-naming";
import { viewHistory } from "./views";

/**
 * The For You order: a personal ranking over the clips the feed's filters
 * allow, computed once per visit and paged from a cache.
 *
 * Why not in SQL: the score mixes per-viewer weights for creators and tags
 * with the clip's own tags, which live in the caption. Scoring a few
 * thousand candidates in JS costs milliseconds; expressing that in SQLite
 * would cost a GLOB per tag per row. Ranking once per visit (keyed on the
 * viewer, the seed and the filters) also makes paging stable: an offset
 * into a fresh query shifts when a clip is added or liked mid-scroll.
 */

export interface Candidate {
  id: number;
  profile_id: number | null;
  uploader_id: number | null;
  profile_name: string | null;
  uploader_name: string | null;
  caption: string | null;
  created_at: string;
  like_count: number;
  comment_count: number;
  /** The viewer already liked or saved it: engaged with, so treated as seen. */
  viewer_engaged: number;
}

export interface Ranked {
  ids: number[];
  reasons: Map<number, string>;
}

/** How many of the newest matching clips are scored; older ones wait a visit. */
export const CANDIDATE_POOL = 4000;

const CACHE_TTL_MS = 15 * 60_000;
const CACHE_MAX = 200;
const cache = new Map<string, { at: number; ranked: Ranked }>();

/** Seeded noise in [0, 1) from the clip id, stable for one visit. */
function noise(id: number, seed: number): number {
  let x = (Math.imul(id ^ 0x9e3779b9, 1103515245) + seed) >>> 0;
  x ^= x >>> 13;
  x = Math.imul(x, 0x5bd1e995) >>> 0;
  x ^= x >>> 15;
  return (x >>> 0) / 4294967296;
}

/** Squashes a summed weight into (-1, 1) so one favourite cannot run away. */
function squash(w: number): number {
  return Math.tanh(w / 8);
}

function ageDays(createdAt: string, now: number): number {
  const then = new Date(createdAt.includes("T") ? createdAt : createdAt.replace(" ", "T") + "Z");
  return Math.max(0, (now - then.getTime()) / 86_400_000);
}

/** "Because you ___ clips from X." */
const CREATOR_VERB: Record<Source, string> = {
  like: "liked",
  save: "saved",
  comment: "commented on",
  watch: "watch",
};
/** "Tagged #t, ___." */
const TAG_PHRASE: Record<Source, string> = {
  like: "like clips you liked",
  save: "like clips you saved",
  comment: "like clips you commented on",
  watch: "which you watch",
};

function creatorName(c: Candidate): string | null {
  return c.profile_name ?? c.uploader_name;
}

/** At most this many clips in a row from one creator. */
const RUN_LIMIT = 2;
/** Every Nth slot goes to a creator the viewer has no history with, when there is one. */
const EXPLORE_EVERY = 6;
/** Each clip from a creator among the last FATIGUE_WINDOW scales their next one by this. */
const FATIGUE = 0.72;
/** Fatigue wears off with distance, so a favourite keeps turning up deep in the feed. */
const FATIGUE_WINDOW = 12;
/** Queue key for clips without a creator: no fatigue and no run limit. */
const NO_CREATOR = "\0";

export function rankCandidates(
  cands: Candidate[],
  aff: Affinity,
  history: ReturnType<typeof viewHistory>,
  seed: number,
  now = Date.now()
): Ranked {
  // A cold feed (nothing liked, saved, followed or finished yet) leans on
  // freshness and popularity; a warm one on taste.
  const warm = Math.min(1, aff.evidence / 25);
  const wCreator = 1.1 * warm;
  const wTag = 0.7 * warm;
  const wPop = 0.3 + 0.4 * (1 - warm);
  const wFresh = 0.45 + 0.35 * (1 - warm);
  const wNoise = 0.35;

  const reasons = new Map<number, string>();
  const scored = cands.map((c) => {
    const ck = creatorKey(c);
    const cw = ck ? aff.creators.get(ck) ?? 0 : 0;
    const creator = squash(cw);

    const tagList = parseHashtags(c.caption);
    let tagSum = 0;
    let bestTag: string | null = null;
    let bestTagW = 0;
    for (const t of tagList) {
      const tw = aff.tags.get(t) ?? 0;
      tagSum += squash(tw);
      if (tw > bestTagW) {
        bestTagW = tw;
        bestTag = t;
      }
    }
    const tag = tagList.length ? tagSum / tagList.length : 0;

    const pop = Math.min(1, Math.log1p(c.like_count * 2 + c.comment_count * 3) / Math.log1p(40));
    const fresh = Math.exp(-ageDays(c.created_at, now) / 21);
    const n = noise(c.id, seed);

    let score = wCreator * creator + wTag * tag + wPop * pop + wFresh * fresh + wNoise * n;

    // Seen before: pushed well down, a little less if only glimpsed, and
    // further if it was today.
    const h = history.get(c.id);
    if (h) {
      score *= h.completed ? 0.12 : 0.35;
      const sinceDays = ageDays(h.lastViewedAt, now);
      if (sinceDays < 1) score *= 0.5;
    } else if (c.viewer_engaged) {
      // Liked or saved from a grid without a watch row: still not new.
      score *= 0.2;
    }

    const name = creatorName(c);
    let reason: string;
    if (ck && aff.followed.has(ck)) {
      reason = name ? `From ${name}, who you follow.` : "From a creator you follow.";
    } else if (cw >= 3 && name && ck && aff.creatorSource.has(ck)) {
      // Named after the signal that gave the weight: a creator known only
      // from saves or finished clips was never "liked".
      reason = `Because you ${CREATOR_VERB[aff.creatorSource.get(ck)!]} clips from ${name}.`;
    } else if (bestTag && bestTagW >= 2 && aff.tagSource.has(bestTag)) {
      reason = `Tagged #${bestTag}, ${TAG_PHRASE[aff.tagSource.get(bestTag)!]}.`;
    } else if (c.like_count >= 1) {
      reason = `Popular here: ${c.like_count} ${c.like_count === 1 ? "like" : "likes"}${
        c.comment_count ? ` and ${c.comment_count} ${c.comment_count === 1 ? "comment" : "comments"}` : ""
      }.`;
    } else if (fresh > 0.7) {
      reason = "Added recently.";
    } else {
      reason = "A fresh pick mixed in so the feed is not only the popular clips.";
    }
    reasons.set(c.id, reason);

    // No history with the creator at all, in either direction. Labelled
    // "New to you" only when it lands on an explore slot, not on every such
    // clip: for a young account that would be most of the feed.
    const unexplored = !!ck && !aff.seenCreators.has(ck) && !h && !c.viewer_engaged && cw <= 0;
    const newReason = name ? `New to you: ${name}.` : "A creator you have not seen yet.";
    return { c, ck, score, unexplored, newReason };
  });

  scored.sort((a, b) => b.score - a.score);

  // Interleave the whole list: each clip from a creator among the last
  // FATIGUE_WINDOW slots makes their next one count for less (so a favourite
  // leads but does not fill the feed), no more than RUN_LIMIT in a row from
  // one creator, and a regular slot for a creator the viewer has no history
  // with. Each creator is a queue in score order, so a step compares one clip
  // per creator; a creator with a third of the pool can no longer crowd every
  // other one out of a fixed top window.
  const queues = new Map<string, typeof scored>();
  for (const s of scored) {
    const k = s.ck ?? NO_CREATOR;
    const q = queues.get(k);
    if (q) q.push(s);
    else queues.set(k, [s]);
  }
  const pos = new Map<string, number>();
  const out: number[] = [];
  const placed = new Map<string, number>();
  const lastPlaced: (string | null)[] = [];
  const recent: (string | null)[] = [];
  const fatigue = (ck: string | null) => (ck ? Math.pow(FATIGUE, placed.get(ck) ?? 0) : 1);
  const runBlocked = (ck: string | null) =>
    ck !== null && recent.length >= RUN_LIMIT && recent.every((r) => r === ck);
  const pickBest = (onlyExplore: boolean, ignoreRuns: boolean): string | null => {
    let best: string | null = null;
    let bestScore = -Infinity;
    for (const [k, q] of queues) {
      const s = q[pos.get(k) ?? 0];
      if (onlyExplore && !s.unexplored) continue;
      if (!ignoreRuns && runBlocked(s.ck)) continue;
      const eff = s.score * fatigue(s.ck);
      if (eff > bestScore) {
        bestScore = eff;
        best = k;
      }
    }
    return best;
  };
  while (queues.size > 0) {
    let k: string | null = null;
    let explore = false;
    if (out.length > 0 && out.length % EXPLORE_EVERY === 0) {
      k = pickBest(true, false);
      explore = k !== null;
    }
    // Only run-blocked clips left means one creator remains: take theirs.
    k ??= pickBest(false, false) ?? pickBest(false, true);
    if (k === null) break;
    const q = queues.get(k)!;
    const i = pos.get(k) ?? 0;
    const s = q[i];
    if (i + 1 < q.length) pos.set(k, i + 1);
    else queues.delete(k);
    out.push(s.c.id);
    if (explore && warm > 0.2) reasons.set(s.c.id, s.newReason);
    if (s.ck) placed.set(s.ck, (placed.get(s.ck) ?? 0) + 1);
    lastPlaced.push(s.ck);
    if (lastPlaced.length > FATIGUE_WINDOW) {
      const old = lastPlaced.shift();
      if (old) placed.set(old, placed.get(old)! - 1);
    }
    recent.push(s.ck);
    if (recent.length > RUN_LIMIT) recent.shift();
  }

  return { ids: out, reasons };
}

function cacheKey(viewerId: number, seed: number, filterKey: string): string {
  return `${viewerId}|${seed}|${filterKey}`;
}

/**
 * The ranked order for this visit, computed on the first page and reused by
 * the next ones. `loadCandidates` runs only on a miss.
 */
export function rankedForVisit(
  viewerId: number,
  seed: number,
  filterKey: string,
  loadCandidates: () => Candidate[]
): Ranked {
  const key = cacheKey(viewerId, seed, filterKey);
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_TTL_MS) {
    // Sliding: a visit still scrolling keeps its order. Re-ranking under a
    // live offset would shift clips across the page boundary and skip some.
    hit.at = now;
    return hit.ranked;
  }

  const aff = computeAffinity(viewerId);
  const history = viewHistory(viewerId);
  const ranked = rankCandidates(loadCandidates(), aff, history, seed, now);

  if (cache.size >= CACHE_MAX) {
    for (const [k, v] of cache) {
      if (now - v.at >= CACHE_TTL_MS) cache.delete(k);
    }
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
  }
  cache.set(key, { at: now, ranked });
  return ranked;
}
