import { cookies, headers } from "next/headers";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { db, UserRow } from "./db";
import { qb, getOne } from "./kysely";

/**
 * Who is browsing.
 *
 * The app keeps its own accounts: `users` and `sessions` in its own database.
 * It used to borrow elite-v2's login over HTTP; that app is gone, and the
 * account ids were already elite-v2's, so every like, upload and playlist still
 * belongs to the same person.
 *
 * A session is a random token in an HttpOnly cookie. Only its SHA-256 is
 * stored, so signing out — or deleting the row — ends it on the next request.
 * The cookie is scoped to this host alone: no `Domain`, so nothing else under
 * the parent domain receives it.
 */
export const SESSION_COOKIE = "tikshortis_session";
const SESSION_DAYS = 30;

/**
 * The session shape the rest of the app reads.
 *
 * `sub` is a string for the same reason it was one in elite-v2 — it came from
 * a JWT subject — and every caller already does `Number(session.sub)`. Keeping
 * the name and the type means the ported code did not have to change.
 */
export interface Session {
  sub: string;
  email: string;
  role: "user" | "admin";
  username: string | null;
  displayName: string | null;
  avatarUrl: string | null;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Read the current session from the request cookies. Works in server
 * components and route handlers alike (Node runtime, not edge).
 *
 * The cookie is looked for before the database is touched: a signed-out
 * request never opens it.
 */
export async function getSession(): Promise<Session | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.id, u.email, u.role, u.username, u.display_name, u.avatar_url
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ? AND s.expires_at > ?`
    )
    .get(hashToken(token), new Date().toISOString()) as
    | Pick<UserRow, "id" | "email" | "role" | "username" | "display_name" | "avatar_url">
    | undefined;
  if (!row) return null;
  return {
    sub: String(row.id),
    email: row.email,
    role: row.role === "admin" ? "admin" : "user",
    username: row.username,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
  };
}

export function startSession(userId: number): { token: string; expires: Date } {
  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_DAYS * 86_400_000);
  // Expired rows are swept here rather than on a timer: a login is rare, and
  // nothing else ever reads a session that has run out.
  db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now.toISOString());
  db.prepare(
    "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)"
  ).run(hashToken(token), userId, now.toISOString(), expires.toISOString());
  return { token, expires };
}

export function endSession(token: string): void {
  db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token));
}

/**
 * Whether the browser reached us over HTTPS. The reverse proxy terminates TLS,
 * so the request this app sees is plain HTTP and the original scheme is a
 * header. A cookie marked Secure on a plain-HTTP LAN address would never come
 * back.
 */
function overHttps(request: Request): boolean {
  return (
    request.headers.get("x-forwarded-proto") === "https" ||
    new URL(request.url).protocol === "https:"
  );
}

export function sessionCookie(request: Request, token: string, expires: Date): string {
  return [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Expires=${expires.toUTCString()}`,
    ...(overHttps(request) ? ["Secure"] : []),
  ].join("; ");
}

export function clearedSessionCookie(request: Request): string {
  return [
    `${SESSION_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
    ...(overHttps(request) ? ["Secure"] : []),
  ].join("; ");
}

export function isAdmin(session: Session | null): boolean {
  return session?.role === "admin";
}

/**
 * A cookie is attached by the browser on its own, and `SameSite=lax` does not
 * separate this host from any other on the parent domain — every page on it is
 * the same site, and can send a request here that carries our cookie. So a
 * state-changing request has to prove it came from a page served by THIS host.
 * Reads skip the check.
 *
 * A request with no Origin at all is a non-browser caller (curl, a script);
 * those authenticate with the admin token instead and never reach here with a
 * cookie, so a missing Origin fails closed.
 */
export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

/**
 * The proof for a GET that changes state (the grab proxies, which EventSource
 * and a plain link can only reach with GET). A same-origin GET carries no
 * Origin header, so this reads what the browser does send: `Sec-Fetch-Site`
 * (every current browser), else the Referer, which the app's own
 * `Referrer-Policy: same-origin` guarantees for its own pages. An <img> or a
 * link on a sibling subdomain arrives as `same-site` with a foreign Referer,
 * and fails.
 */
export function sameOriginPage(request: Request): boolean {
  if (sameOrigin(request)) return true;
  const site = request.headers.get("sec-fetch-site");
  if (site) return site === "same-origin";
  const referer = request.headers.get("referer");
  if (!referer) return false;
  try {
    return new URL(referer).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

/**
 * The credential the host timers present. `docker exec`-ed scripts talk to the
 * routes over HTTP and have no browser; unset means closed, never "no gate
 * configured, let it through" — this app answers on a public hostname.
 */
export function hasAdminToken(request: Request): boolean {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) return false;
  const given = request.headers.get("x-admin-token");
  if (!given) return false;
  // Constant-time: a plain === returns at the first differing byte, which lets
  // a caller measure how much of a guess was right.
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Gate for a write route: either an admin session that came from one of this
 * app's own pages, or the admin token.
 *
 * Returns null when the caller is allowed; otherwise the response to send.
 */
export async function requireAdmin(request: Request): Promise<Response | null> {
  if (hasAdminToken(request)) return null;
  const session = await getSession();
  if (!session) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!sameOrigin(request)) {
    return Response.json({ error: "Bad origin" }, { status: 403 });
  }
  if (session.role !== "admin") {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }
  return null;
}

/** An account, for rendering a name next to their content. Never the password hash. */
export function getUserById(
  id: number
): Omit<UserRow, "password_hash"> | undefined {
  return getOne<Omit<UserRow, "password_hash">>(
    qb
      .selectFrom("users")
      .select(["id", "email", "role", "username", "display_name", "avatar_url", "synced_at"])
      .where("id", "=", id)
  );
}

/** The handle content is filed under: the username when set, else the email's local part. */
export function handleFor(user: Pick<UserRow, "username" | "email">): string {
  return user.username || user.email.split("@")[0];
}

/** The absolute URL of this app, for links that leave it and come back. */
export async function selfUrl(): Promise<string> {
  const configured = process.env.APP_URL;
  if (configured) return configured.replace(/\/$/, "");
  const h = await headers();
  const host = h.get("host");
  return host ? `https://${host}` : "";
}
