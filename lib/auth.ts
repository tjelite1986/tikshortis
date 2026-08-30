import { cookies, headers } from "next/headers";
import { db, UserRow } from "./db";
import { qb, getOne } from "./kysely";
import { SESSION_COOKIE, verifyToken, type Appearance } from "./sso";

/**
 * The session shape the rest of the app reads.
 *
 * `sub` is a string for the same reason it was one in elite-v2 — it comes from
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
  appearance?: Appearance;
}

/**
 * Mirror the account elite-v2 just vouched for.
 *
 * The row is what lets a comment or an upload render a name without a second
 * round trip, and it is refreshed on every verify rather than written once:
 * a rename in elite-v2 has to reach the clips filed under the old handle.
 */
function mirrorUser(user: {
  id: number;
  email: string;
  role: string;
  username?: string | null;
  displayName?: string | null;
  avatarUrl?: string | null;
}): void {
  db.prepare(
    `INSERT INTO users (id, email, role, username, display_name, avatar_url, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       email = excluded.email,
       role = excluded.role,
       username = COALESCE(excluded.username, users.username),
       display_name = COALESCE(excluded.display_name, users.display_name),
       avatar_url = excluded.avatar_url,
       synced_at = excluded.synced_at`
  ).run(
    user.id,
    user.email,
    user.role,
    user.username ?? null,
    user.displayName ?? null,
    user.avatarUrl ?? null
  );
}

/**
 * Read the current session from the request cookies. Works in server
 * components and route handlers alike (Node runtime, not edge).
 */
export async function getSession(): Promise<Session | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const user = await verifyToken(token);
  if (!user) return null;
  mirrorUser(user);
  return {
    sub: String(user.id),
    email: user.email,
    role: user.role,
    username: user.username ?? null,
    displayName: user.displayName ?? null,
    avatarUrl: user.avatarUrl ?? null,
    appearance: user.appearance,
  };
}

export function isAdmin(session: Session | null): boolean {
  return session?.role === "admin";
}

/**
 * A cookie is attached by the browser on its own, and `SameSite=lax` does not
 * separate this host from any other on the parent domain — every page on it is
 * the same site. So a state-changing request has to prove it came from a page
 * served by THIS host. Reads skip the check.
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
 * The credential the host timers present. `docker exec`-ed scripts talk to the
 * routes over HTTP and have no browser; unset means closed, never "no gate
 * configured, let it through" — this app answers on a public hostname.
 */
export function hasAdminToken(request: Request): boolean {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) return false;
  return request.headers.get("x-admin-token") === expected;
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

/** The mirrored row for an account, for rendering a name next to their content. */
export function getUserById(id: number): UserRow | undefined {
  return getOne<UserRow>(
    qb.selectFrom("users").selectAll().where("id", "=", id)
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
