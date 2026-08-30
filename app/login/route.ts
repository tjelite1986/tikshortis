import { NextResponse } from "next/server";
import { loginUrl } from "@/lib/sso";

export const dynamic = "force-dynamic";

/**
 * There is no sign-in form here — the accounts are elite-v2's. This exists so
 * that `/login` is a real address: the ported pages redirect to it when they
 * find no session, and a bookmark or a stale link lands somewhere that works
 * instead of on a 404.
 *
 * `next` is only ever a path on this host. It is not read from the request:
 * a caller-supplied return address is exactly what turns a login hop into an
 * open redirect, and there is nothing here worth that.
 */
export function GET(request: Request) {
  const path = new URL(request.url).searchParams.get("next");
  const safe = path && path.startsWith("/") && !path.startsWith("//") ? path : "/";
  const target = loginUrl(safe);
  return NextResponse.redirect(target || new URL("/", request.url), 302);
}
