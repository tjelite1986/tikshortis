import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { canAccessChannel, canViewShort, getShort } from "@/lib/shorts";
import { recordViews, type ViewReport } from "@/lib/views";

export const dynamic = "force-dynamic";

/** A beacon carries what one scroll session produced; a loop is not a session. */
const MAX_REPORTS = 50;
const MAX_BODY_BYTES = 8 * 1024;

/**
 * Reads the body up to the cap. A request without Content-Length (chunked)
 * would otherwise be read whole before the size could be checked.
 */
async function readCapped(request: Request): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Only clips the viewer may see count as watched: the same rule as every
 * single-clip route, so a guessed id of someone's private clip, a deleted
 * clip or another channel's clip never lands in short_views.
 */
async function visibleReports(
  reports: ViewReport[],
  viewerId: number,
  isAdmin: boolean
): Promise<ViewReport[]> {
  const out: ViewReport[] = [];
  for (const r of reports) {
    const short = getShort(r.id);
    if (!short || !canViewShort(short, viewerId, isAdmin)) continue;
    if (!(await canAccessChannel(short.channel))) continue;
    out.push(r);
  }
  return out;
}

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
    const text = await readCapped(request);
    if (text === null) return new NextResponse(null, { status: 413 });
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
  const viewerId = Number(session.sub);
  const allowed = await visibleReports(reports, viewerId, session.role === "admin");
  if (allowed.length) recordViews(viewerId, allowed);
  return new NextResponse(null, { status: 204 });
}
