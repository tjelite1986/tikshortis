import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

// Liveness for the container HEALTHCHECK and external monitoring. Unauthenticated
// on purpose: it says only whether the server answers and the database opens,
// never anything about the library. A failing query is a 503 so the container
// turns unhealthy instead of green-with-a-broken-db.
export async function GET() {
  try {
    db.prepare("SELECT 1").get();
    return NextResponse.json(
      { ok: true },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("[health] database check failed:", error);
    return NextResponse.json(
      { ok: false },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
