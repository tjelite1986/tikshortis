import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

// The viewer's "Not interested" list, as a count: enough for the Settings
// card, which only offers to clear the whole list. Deleted clips are not
// counted (the row cascades away with the clip).
export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM short_hides WHERE user_id = ?")
    .get(Number(session.sub)) as { n: number };
  return NextResponse.json({ count: row.n });
}

// Show every hidden clip again.
export async function DELETE() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const result = db
    .prepare("DELETE FROM short_hides WHERE user_id = ?")
    .run(Number(session.sub));
  return NextResponse.json({ ok: true, cleared: result.changes });
}
