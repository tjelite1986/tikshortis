import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { recordViews, type ViewReport } from "@/lib/views";

export const dynamic = "force-dynamic";

/** A beacon carries what one scroll session produced; a loop is not a session. */
const MAX_REPORTS = 50;
const MAX_BODY_BYTES = 8 * 1024;

/**
 * The player's watch beacon. Sent with navigator.sendBeacon when a clip leaves
 * the screen and when the page is hidden, so it arrives as text without a
 * Content-Type to rely on. Answers 204 whatever happened: there is nothing for
 * the sender to do with a failure.
 */
export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return new NextResponse(null, { status: 401 });

  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return new NextResponse(null, { status: 413 });

  let reports: ViewReport[] = [];
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) return new NextResponse(null, { status: 413 });
    const body = JSON.parse(text) as { views?: unknown };
    if (Array.isArray(body.views)) {
      reports = body.views
        .filter(
          (v): v is { id: number; watchMs?: unknown; completed?: unknown } =>
            typeof v === "object" && v !== null && Number.isInteger((v as { id?: unknown }).id)
        )
        .slice(0, MAX_REPORTS)
        .map((v) => ({
          id: v.id,
          watchMs: typeof v.watchMs === "number" && Number.isFinite(v.watchMs) ? v.watchMs : 0,
          completed: v.completed === true,
        }));
    }
  } catch {
    return new NextResponse(null, { status: 204 });
  }
  if (reports.length) recordViews(Number(session.sub), reports);
  return new NextResponse(null, { status: 204 });
}
