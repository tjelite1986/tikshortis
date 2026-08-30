/**
 * Who is browsing, according to elite-v2.
 *
 * Tikshortis has no accounts. It sits on the same parent domain as elite-v2,
 * which scopes its session cookie to that domain, so a browser logged in there
 * sends the same cookie here. That gets the token to us; it does not tell us
 * whether it is still good. Verifying the signature locally would need
 * elite-v2's `JWT_SECRET`, and would still accept a session that has been
 * revoked — the row proving it exists is in elite-v2's database, and a revoked
 * token stays signed for a week. So the token goes back to elite-v2 to be
 * resolved, and the signing secret stays in the one app that needs it.
 *
 * The cost is a round trip. It is paid over the internal docker network
 * (`ELITE_VERIFY_URL` points at the container, not the public hostname) and
 * answers are cached for 30 s, so a page that resolves the session several
 * times asks once and revocation lags by at most that.
 */
export const SESSION_COOKIE = "elite_session";
const TTL_MS = 30_000;
const TIMEOUT_MS = 5_000;

export interface EliteUser {
  id: number;
  email: string;
  role: "user" | "admin";
  /**
   * The public face of the account: the handle clips are filed under and the
   * avatar shown beside a comment. elite-v2 owns these — an older verify
   * endpoint simply omits them and the UI falls back to the email's local part.
   */
  username?: string | null;
  displayName?: string | null;
  avatarUrl?: string | null;
  /**
   * How the site this login comes from is painted for this account. Present
   * only when that app sends it — otherwise Tikshortis keeps its own colours.
   */
  appearance?: Appearance;
}

/**
 * Two CSS values, not a theme. Both apps name these tokens `--accent` and
 * `--app-bg`, so adopting them is a matter of writing two custom properties.
 */
export interface Appearance {
  accent: string;
  bg: string;
}

/**
 * Values from another app end up inside a `<style>` block, so they are checked
 * here rather than trusted: an accent must be a plain hex colour, and a
 * background may not carry anything that could close the declaration it sits
 * in. elite-v2 validates both on its side — this is the second lock, for the
 * day something else answers that endpoint.
 */
function cleanAppearance(value: unknown): Appearance | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { accent, bg } = value as { accent?: unknown; bg?: unknown };
  if (typeof accent !== "string" || !/^#[0-9a-fA-F]{6}$/.test(accent)) {
    return undefined;
  }
  if (typeof bg !== "string" || bg.length > 400 || /[;{}<>@\\]/.test(bg)) {
    return undefined;
  }
  return { accent, bg };
}

/** A remote avatar URL is rendered as an <img src>. Only elite-v2's own. */
function cleanAvatarUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  const base = process.env.ELITE_APP_URL;
  if (value.startsWith("/")) return base ? `${base}${value}` : null;
  if (!base || !value.startsWith(`${base}/`)) return null;
  return value;
}

function cleanHandle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= 64 ? trimmed : null;
}

type Entry = { at: number; user: EliteUser | null };
const cache = new Map<string, Entry>();

export function ssoConfigured(): boolean {
  return !!process.env.ELITE_VERIFY_URL;
}

/**
 * Failures are cached alongside successes, and for the same short window: a
 * revoked session has to stop working promptly, and a token that is simply
 * junk must not turn every request into a round trip.
 */
function remember(token: string, user: EliteUser | null): EliteUser | null {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now - entry.at >= TTL_MS) cache.delete(key);
  }
  cache.set(token, { at: now, user });
  return user;
}

/** Resolve a raw session token against elite-v2. */
export async function verifyToken(token: string): Promise<EliteUser | null> {
  const url = process.env.ELITE_VERIFY_URL;
  if (!url || !token) return null;

  const hit = cache.get(token);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.user;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (err) {
    // elite-v2 being unreachable is not the same as a bad session, and must not
    // be cached as one — say so in the log, and let the next request try.
    console.error("[sso] could not reach elite-v2 to verify a session:", err);
    return null;
  }

  if (res.status === 401) return remember(token, null);
  if (!res.ok) {
    console.error("[sso] verify answered HTTP", res.status);
    return null;
  }

  const body = (await res.json().catch(() => null)) as {
    ok?: boolean;
    user?: {
      id?: unknown;
      email?: unknown;
      role?: unknown;
      username?: unknown;
      displayName?: unknown;
      avatarUrl?: unknown;
    };
    appearance?: unknown;
  } | null;
  const user = body?.ok ? body.user : undefined;
  if (
    typeof user?.id !== "number" ||
    typeof user.email !== "string" ||
    (user.role !== "user" && user.role !== "admin")
  ) {
    console.error("[sso] verify returned a body this app does not understand");
    return null;
  }
  return remember(token, {
    id: user.id,
    email: user.email,
    role: user.role,
    username: cleanHandle(user.username),
    displayName: cleanHandle(user.displayName),
    avatarUrl: cleanAvatarUrl(user.avatarUrl),
    appearance: cleanAppearance(body?.appearance),
  });
}

/** Where a signed-out visitor is sent to sign in, and back again afterwards. */
export function loginUrl(returnTo?: string): string {
  const base = process.env.ELITE_APP_URL;
  if (!base) return "/";
  const self = process.env.APP_URL || "";
  const next = self && returnTo ? `${self}${returnTo}` : self;
  return next
    ? `${base}/login?next=${encodeURIComponent(next)}`
    : `${base}/login`;
}
