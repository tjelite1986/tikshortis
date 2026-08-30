import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Cross-site request forgery, for a cookie this app did not set.
 *
 * The session cookie belongs to elite-v2 and is scoped to the parent domain, so
 * the browser attaches it to requests for THIS host on its own — and
 * `SameSite=lax` does not help here, because every page on that parent domain
 * counts as the same site. Any page served anywhere on that domain could
 * therefore make an authenticated write to these routes.
 *
 * So a state-changing request has to prove it came from a page this host
 * served. The check lives in middleware rather than in each route because a
 * route that forgets it is indistinguishable from one that does not need it,
 * and there are forty of them.
 *
 * Two ways past it, both deliberate:
 *  - a matching Origin (or, for older clients, a Referer on this host);
 *  - the admin token, which the host timers present. They are not browsers,
 *    send no Origin, and hold a credential no page can read.
 */
export function middleware(request: NextRequest) {
  if (request.method === "GET" || request.method === "HEAD") {
    return NextResponse.next();
  }

  // Presence, not validity: the routes verify the token themselves. This only
  // decides whether the request looks like a browser's.
  if (request.headers.get("x-admin-token")) return NextResponse.next();

  const host = request.headers.get("host");
  const origin = request.headers.get("origin");
  const referer = request.headers.get("referer");

  const sourceHost = (() => {
    for (const value of [origin, referer]) {
      if (!value) continue;
      try {
        return new URL(value).host;
      } catch {
        /* malformed — treated as absent */
      }
    }
    return null;
  })();

  if (host && sourceHost === host) return NextResponse.next();

  return NextResponse.json({ error: "Bad origin" }, { status: 403 });
}

export const config = {
  // Everything but Next's own assets. The check is on the method, so this
  // costs a header read on the GETs it lets straight through.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
