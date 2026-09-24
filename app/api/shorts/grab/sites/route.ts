import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { grabbitFetch, UNREACHABLE } from "@/lib/grabbit";

export const dynamic = "force-dynamic";

// Proxy to the grabbit grabber: list supported sites (admin only).
export async function GET() {
  const session = await getSession();
  if (!session || session.role !== "admin") {
    return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });
  }
  try {
    const r = await grabbitFetch("/api/sites", 15_000);
    // The status is deliberately not forwarded: Cloudflare replaces a 5xx
    // body with its own HTML page, and every caller reads `ok` from the JSON.
    return NextResponse.json(await r.json());
  } catch {
    return NextResponse.json(UNREACHABLE);
  }
}
