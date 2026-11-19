import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { frameAncestors } from "@/lib/embed";
import { contentSecurityPolicy } from "@/lib/csp.mjs";

/**
 * Cross-site request forgery.
 *
 * The session cookie is host-only, but `SameSite=lax` still attaches it to a
 * request from any page on the parent domain, because every page on that
 * domain counts as the same site. Any page served anywhere on that domain
 * could therefore make an authenticated write to these routes.
 *
 * So a state-changing request has to prove it came from a page this host
 * served. The check lives in middleware rather than in each route because a
 * route that forgets it is indistinguishable from one that does not need it,
 * and there are forty of them.
 *
 * Three ways past it, all deliberate:
 *  - a matching Origin (or, for older clients, a Referer on this host);
 *  - the admin token, which the host timers present. They are not browsers,
 *    send no Origin, and hold a credential no page can read;
 *  - Grabbit's dedupe token, for the same reason.
 */
export function middleware(request: NextRequest) {
  return withFrameAncestors(guard(request));
}

/**
 * Who may frame this app is decided per request, from the environment, so
 * Grabbit's hub can embed it without a rebuild (see lib/embed.ts). Unset is
 * `frame-ancestors 'none'`, the value next.config.mjs sends.
 *
 * The whole policy is set here, not just frame-ancestors: a CSP header from
 * middleware replaces the one next.config.mjs sends, so appending only the
 * frame-ancestors directive silently dropped the rest (see lib/csp.mjs).
 */
function withFrameAncestors(res: NextResponse): NextResponse {
  res.headers.set(
    "Content-Security-Policy",
    contentSecurityPolicy(frameAncestors(process.env.EMBED_FRAME_ANCESTORS)),
  );
  return res;
}

function guard(request: NextRequest): NextResponse {
  if (request.method === "GET" || request.method === "HEAD") {
    return NextResponse.next();
  }

  // Presence, not validity: the routes verify the token themselves. This only
  // decides whether the request looks like a browser's.
  if (request.headers.get("x-admin-token")) return NextResponse.next();
  // Grabbit's dedupe calls (app/api/dedupe/v1) skip the origin check only on
  // their own routes, which verify the token themselves. The header opens no
  // other route.
  if (
    request.nextUrl.pathname.startsWith("/api/dedupe/v1/") &&
    request.headers.get("x-grabbit-dedupe-token")
  ) {
    return NextResponse.next();
  }

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
  // The upload route is left out: Next clones a body for middleware and keeps
  // only the first 10 MB of it, so a streamed upload arrived truncated. The
  // route checks the origin itself.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/shorts/upload$).*)"],
};
