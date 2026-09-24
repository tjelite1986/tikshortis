import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { grabbitFetch, UNREACHABLE } from "@/lib/grabbit";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// Proxy to the grabbit grabber: list every clip on a profile (admin only).
export async function GET(req: Request) {
  const session = await getSession();
  if (!session || session.role !== "admin") {
    return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });
  }
  const url = new URL(req.url).searchParams.get("url") || "";
  try {
    const r = await grabbitFetch(`/api/profile?url=${encodeURIComponent(url)}`);
    // The status is deliberately not forwarded: Cloudflare replaces a 5xx
    // body with its own HTML page, and every caller reads `ok` from the JSON.
    return NextResponse.json(await r.json());
  } catch {
    return NextResponse.json(UNREACHABLE);
  }
}
