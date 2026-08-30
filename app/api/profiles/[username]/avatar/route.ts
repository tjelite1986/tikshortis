import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getSession } from "@/lib/auth";
import { SESSION_COOKIE } from "@/lib/sso";

export const dynamic = "force-dynamic";

/**
 * A creator's or account's avatar, fetched from elite-v2 and served from here.
 *
 * The pictures live over there, and an `<img>` cannot reach them directly for
 * two independent reasons: this app's CSP allows images from `'self'` only, and
 * a `SameSite=lax` cookie is not attached to a cross-site image request, so the
 * response would be a 401 rendered as a broken picture rather than the initials
 * the component falls back to. Both go away if the request is same-origin and
 * the hop to elite-v2 happens on the server, where the cookie can be forwarded
 * deliberately.
 *
 * ELITE_INTERNAL_URL points at the container over the traefik network, so this
 * does not go out to the internet and back; ELITE_APP_URL is the fallback.
 */
export async function GET(
  request: Request,
  props: { params: Promise<{ username: string }> }
) {
  const { username } = await props.params;

  // Only for people who are signed in here — this is a window into another
  // app's data, and it should be no wider than the session that opens it.
  const session = await getSession();
  if (!session) return new NextResponse("Unauthorized", { status: 401 });

  const base = process.env.ELITE_INTERNAL_URL || process.env.ELITE_APP_URL;
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!base || !token) return new NextResponse("Not found", { status: 404 });

  const upstream = `${base.replace(/\/$/, "")}/api/profiles/${encodeURIComponent(
    username
  )}/avatar`;

  let res: Response;
  try {
    res = await fetch(upstream, {
      headers: {
        // The cookie is forwarded, not reconstructed: elite-v2 resolves the
        // same session it issued, so this proxy grants nothing the caller did
        // not already have.
        cookie: `${SESSION_COOKIE}=${token}`,
        // Pass the validator through so an unchanged picture still costs a 304
        // rather than a full body on every card in the feed.
        ...(request.headers.get("if-none-match")
          ? { "if-none-match": request.headers.get("if-none-match") as string }
          : {}),
      },
      signal: AbortSignal.timeout(5_000),
      cache: "no-store",
    });
  } catch {
    // Unreachable is not "no avatar", but the component's only two states are
    // picture and initials. 404 gets the initials, which is the honest one.
    return new NextResponse("Not found", { status: 404 });
  }

  if (res.status === 304) {
    return new NextResponse(null, {
      status: 304,
      headers: {
        ETag: res.headers.get("etag") ?? "",
        "Cache-Control": "private, no-cache",
      },
    });
  }
  if (!res.ok) return new NextResponse("Not found", { status: 404 });

  return new NextResponse(await res.arrayBuffer(), {
    headers: {
      "Content-Type": res.headers.get("content-type") ?? "image/jpeg",
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": "inline",
      ETag: res.headers.get("etag") ?? "",
      "Cache-Control": "private, no-cache",
    },
  });
}
