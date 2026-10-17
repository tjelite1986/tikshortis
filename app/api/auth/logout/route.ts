/**
 * POST /api/auth/logout — ends this browser's session.
 *
 * The row is deleted, not just the cookie: a copied cookie stops working the
 * moment its owner signs out. Same-origin only, so another page cannot sign a
 * visitor out behind their back.
 */
import { cookies } from "next/headers";
import {
  SESSION_COOKIE,
  clearedSessionCookie,
  endSession,
  sameOrigin,
} from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  if (!sameOrigin(request)) {
    return Response.json(
      { error: "Cross-origin sign-out is not accepted" },
      { status: 403 }
    );
  }
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (token) endSession(token);
  return Response.json(
    { ok: true },
    { headers: { "set-cookie": clearedSessionCookie(request) } }
  );
}
