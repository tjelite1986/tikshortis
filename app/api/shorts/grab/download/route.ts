import { NextResponse } from "next/server";
import { getSession, sameOriginPage } from "@/lib/auth";
import { grabbitFetch, UNREACHABLE } from "@/lib/grabbit";
import { CHANNEL } from "@/lib/shorts";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// Proxy to the grabbit grabber: download one clip into the channel's import folder
// (save-only — device=0). Admin only.
//
// A GET with a side effect: the middleware's CSRF check covers writes only, so
// this route proves the page itself — an <img src> on a sibling subdomain would
// otherwise carry the admin's cookie straight in.
export async function GET(req: Request) {
  const session = await getSession();
  if (!session || session.role !== "admin") {
    return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });
  }
  if (!sameOriginPage(req)) {
    return NextResponse.json({ ok: false, error: "Bad origin" }, { status: 403 });
  }
  const sp = new URL(req.url).searchParams;
  const qs = new URLSearchParams({
    url: sp.get("url") || "",
    channel: CHANNEL,
    device: "0",
  });
  if (sp.get("creator")) qs.set("creator", sp.get("creator") as string);
  // Metadata a person edited before saving. Passed through even when empty —
  // an empty description is a deliberate "no caption", which grabbit honours
  // (it tests for the parameter being present, not truthy).
  if (sp.get("title") != null) qs.set("title", sp.get("title") as string);
  if (sp.get("description") != null) qs.set("description", sp.get("description") as string);
  if (sp.get("tags") != null) qs.set("tags", sp.get("tags") as string);
  if (sp.get("web") === "1") qs.set("web", "1");
  if (sp.get("quality")) qs.set("quality", sp.get("quality") as string);
  try {
    const r = await grabbitFetch(`/api/download?${qs.toString()}`);
    const data = await r.json().catch(() => ({ ok: false, error: "Download failed" }));
    // Upstream failures are reported in the body, not the status, so the
    // client always gets JSON back (see the catch below).
    return NextResponse.json(data);
  } catch {
    return NextResponse.json(UNREACHABLE);
  }
}
