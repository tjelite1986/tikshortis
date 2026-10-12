import { computeAffinity, creatorKey, type Affinity } from "./affinity";
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

function creatorName(c: Candidate): string | null {
  return c.profile_name ?? c.uploader_name;
}

/** At most this many clips in a row from one creator. */
const RUN_LIMIT = 2;
/** Every Nth slot goes to a creator the viewer has no history with, when there is one. */
const EXPLORE_EVERY = 6;
/** Each clip already placed from a creator scales their next one by this. */
const FATIGUE = 0.72;
/** How many top candidates the interleave weighs against each other. */
const INTERLEAVE_WINDOW = 600;

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
    } else if (cw >= 3 && name) {
      reason = `Because you liked clips from ${name}.`;
    } else if (bestTag && bestTagW >= 2) {
      reason = `Tagged #${bestTag}, which you watch.`;
    } else if (ck && !aff.seenCreators.has(ck) && warm > 0.2) {
      reason = name ? `New to you: ${name}.` : "A creator you have not seen yet.";
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

    // No history with the creator at all, in either direction.
    const unexplored = !!ck && !aff.seenCreators.has(ck) && !h && !c.viewer_engaged && cw <= 0;
    return { c, ck, score, unexplored };
  });

  scored.sort((a, b) => b.score - a.score);

  // Interleave the top of the list: each clip placed from a creator makes
  // their next one count for less (so a favourite leads but does not fill
  // the feed), no more than RUN_LIMIT in a row from one creator, and a
  // regular slot for a creator the viewer has no history with. The long
  // tail below the window keeps its score order.
  const head = scored.slice(0, INTERLEAVE_WINDOW);
  const tail = scored.slice(INTERLEAVE_WINDOW);
  const out: number[] = [];
  const placed = new Map<string, number>();
  const recent: (string | null)[] = [];
  const taken = new Array<boolean>(head.length).fill(false);
  const fatigue = (ck: string | null) => (ck ? Math.pow(FATIGUE, placed.get(ck) ?? 0) : 1);
  const runBlocked = (ck: string | null) =>
    ck !== null && recent.length >= RUN_LIMIT && recent.every((r) => r === ck);
  const push = (idx: number) => {
    const s = head[idx];
    taken[idx] = true;
    out.push(s.c.id);
    if (s.ck) placed.set(s.ck, (placed.get(s.ck) ?? 0) + 1);
    recent.push(s.ck);
    if (recent.length > RUN_LIMIT) recent.shift();
  };
  const pickBest = (onlyExplore: boolean): number => {
    let best = -1;
    let bestScore = -Infinity;
    for (let i = 0; i < head.length; i++) {
      if (taken[i]) continue;
      const s = head[i];
      if (onlyExplore && !s.unexplored) continue;
      if (runBlocked(s.ck)) continue;
      const eff = s.score * fatigue(s.ck);
      if (eff > bestScore) {
        bestScore = eff;
        best = i;
      }
    }
    return best;
  };
  for (let n = 0; n < head.length; n++) {
    let idx = -1;
    if (out.length > 0 && out.length % EXPLORE_EVERY === 0) idx = pickBest(true);
    if (idx === -1) idx = pickBest(false);
    if (idx === -1) {
      // Only run-blocked clips remain: take the best regardless.
      for (let i = 0; i < head.length; i++) {
        if (!taken[i] && (idx === -1 || head[i].score > head[idx].score)) idx = i;
      }
      if (idx === -1) break;
    }
    push(idx);
  }
  for (const s of tail) out.push(s.c.id);

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
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.ranked;

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

/** Forgets a viewer's rankings, e.g. after they hid a clip mid-scroll. */
export function forgetRankings(viewerId: number): void {
  for (const k of cache.keys()) if (k.startsWith(`${viewerId}|`)) cache.delete(k);
}
