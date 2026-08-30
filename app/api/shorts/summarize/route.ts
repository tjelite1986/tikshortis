import { NextResponse } from "next/server";
import { getSession, hasAdminToken } from "@/lib/auth";
import { canAccessChannel } from "@/lib/shorts";
import {
  requeueShortSummary,
  shortChannelOf,
  shortSummaryOf,
  shortSummaryState,
  startShortSummaryOne,
  startShortSummaryRun,
} from "@/lib/short-summary";

export const dynamic = "force-dynamic";

// Queue state for the UI and the scheduler. POST returns as soon as the work
// is started, never when it finishes.
export async function GET(request: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // ?id=<n> reads back one clip's description — what the UI polls for after
  // starting a run. Same channel check as everywhere else here.
  const id = Number(new URL(request.url).searchParams.get("id"));
  if (Number.isFinite(id) && id > 0) {
    const channel = shortChannelOf(id);
    if (!channel) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (!(await canAccessChannel(channel))) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json({ summary: shortSummaryOf(id) });
  }

  return NextResponse.json(shortSummaryState());
}

// Start summarising. Admin session (the button) or ADMIN_TOKEN (a scheduled
// run, which has no browser). ?id=<n> describes just that clip.
export async function POST(request: Request) {
  const session = await getSession();
  const isCron = hasAdminToken(request);
  if (session?.role !== "admin" && !isCron) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const one = Number(url.searchParams.get("id"));
  if (Number.isFinite(one) && one > 0) {
    // 404 rather than 403 when the clip is on a channel this app does not
    // serve: the existence of the clip is itself information.
    const channel = shortChannelOf(one);
    if (!channel) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (!isCron && !(await canAccessChannel(channel))) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    requeueShortSummary(one);
    return NextResponse.json({ ok: true, ...startShortSummaryOne(one) });
  }

  const budget = Number(url.searchParams.get("budgetMs"));
  return NextResponse.json({
    ok: true,
    ...startShortSummaryRun(
      Number.isFinite(budget) && budget > 0 ? budget : undefined
    ),
  });
}
