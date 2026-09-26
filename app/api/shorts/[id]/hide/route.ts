import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { canAccessChannel, canViewShort, getShort } from "@/lib/shorts";

export const dynamic = "force-dynamic";

// "Not interested": POST hides the clip from the viewer's feeds, DELETE shows
// it again. Both are idempotent — a double-tap or a retry lands on the same
// row — so neither needs the like route's read-then-write transaction.
async function resolve(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const session = await getSession();
  if (!session) {
    return {
      error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }
  const userId = Number(session.sub);
  const short = getShort(Number(params.id));
  if (!short || !canViewShort(short, userId, session.role === "admin")) {
    return {
      error: NextResponse.json({ error: "Not found" }, { status: 404 }),
    };
  }
  if (!(await canAccessChannel(short.channel))) {
    return { error: NextResponse.json({ error: "Locked" }, { status: 403 }) };
  }
  return { userId, shortId: short.id };
}

export async function POST(
  _request: Request,
  props: { params: Promise<{ id: string }> },
) {
  const r = await resolve(props);
  if ("error" in r) return r.error;
  db.prepare(
    "INSERT OR IGNORE INTO short_hides (short_id, user_id) VALUES (?, ?)",
  ).run(r.shortId, r.userId);
  return NextResponse.json({ ok: true, hidden: true });
}

export async function DELETE(
  _request: Request,
  props: { params: Promise<{ id: string }> },
) {
  const r = await resolve(props);
  if ("error" in r) return r.error;
  db.prepare("DELETE FROM short_hides WHERE short_id = ? AND user_id = ?").run(
    r.shortId,
    r.userId,
  );
  return NextResponse.json({ ok: true, hidden: false });
}
