import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { canAccessChannel, canViewShort, getShort } from "@/lib/shorts";
import { parseReportReason } from "@/lib/report-reasons";
import { REPORT_NOTE_MAX, reportShort } from "@/lib/shorts-reports";

export const dynamic = "force-dynamic";

// Report a clip: { reason, note? }. One report per viewer and clip — a repeat
// replaces the first — and the clip is hidden from the reporter's feed at once
// (see lib/shorts-reports). There is no DELETE: a sent report is the admin's to
// close, not the reporter's; the hide it caused can still be undone through
// /api/shorts/[id]/hide like any other.
export async function POST(
  request: Request,
  props: { params: Promise<{ id: string }> },
) {
  const params = await props.params;
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = Number(session.sub);
  const short = getShort(Number(params.id));
  if (!short || !canViewShort(short, userId, session.role === "admin")) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (!(await canAccessChannel(short.channel))) {
    return NextResponse.json({ error: "Locked" }, { status: 403 });
  }
  let body: { reason?: unknown; note?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const reason = parseReportReason(body.reason);
  if (!reason) {
    return NextResponse.json({ error: "Unknown reason" }, { status: 400 });
  }
  if (body.note !== undefined && typeof body.note !== "string") {
    return NextResponse.json({ error: "Invalid note" }, { status: 400 });
  }
  if (typeof body.note === "string" && body.note.length > REPORT_NOTE_MAX) {
    return NextResponse.json({ error: "Note too long" }, { status: 400 });
  }
  reportShort(
    short.id,
    userId,
    reason,
    typeof body.note === "string" ? body.note : null,
  );
  return NextResponse.json({ ok: true, reported: true, hidden: true });
}
