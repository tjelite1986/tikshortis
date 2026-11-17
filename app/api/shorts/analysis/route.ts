import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { CHANNEL } from "@/lib/shorts";
import { analysedShorts } from "@/lib/short-summary";

export const dynamic = "force-dynamic";

// The Analysis page's list (public clips with an AI summary), for clients
// outside this app.
export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ items: analysedShorts(CHANNEL) });
}
