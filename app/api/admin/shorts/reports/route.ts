import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { dismissReports, listReportedShorts } from "@/lib/shorts-reports";

export const dynamic = "force-dynamic";

// Admin: the clips with open reports, grouped per clip with every report's
// reason, note and reporter.
export async function GET() {
  const session = await getSession();
  if (!session)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return NextResponse.json({ items: listReportedShorts() });
}

// Admin: { shortId, action: "dismiss" } closes a clip's open reports. Deleting
// the clip goes through DELETE /api/shorts/[id] as everywhere else; the list
// drops a deleted clip on its own.
export async function POST(request: Request) {
  const session = await getSession();
  if (!session)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  let body: { shortId?: unknown; action?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const shortId = Number(body.shortId);
  if (!Number.isInteger(shortId) || shortId <= 0) {
    return NextResponse.json({ error: "Invalid shortId" }, { status: 400 });
  }
  if (body.action !== "dismiss") {
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }
  return NextResponse.json({ ok: true, dismissed: dismissReports(shortId) });
}
