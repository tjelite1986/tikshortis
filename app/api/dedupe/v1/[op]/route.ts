import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { SHORTS_ROOT } from "@/lib/shorts-storage";
import { DedupeError, link, lookup, opStatus, purge, restore, status, tokenOk, type Ctx } from "@/lib/grabbit-dedupe";

export const dynamic = "force-dynamic";

// Grabbit dedupe v1 (see lib/grabbit-dedupe.ts). Machine-to-machine only:
// every call needs X-Grabbit-Dedupe-Token; there is no session path.
//   POST lookup  { paths: string[] }
//   POST link    { keep, drop, sha256, op? }
//   POST opstatus { op }
//   POST restore { id, uid }
//   POST purge   { id, uid }
//   GET  status

type Params = { params: Promise<{ op: string }> };

function ctx(): Ctx {
  return { db, shortsRoot: SHORTS_ROOT };
}

function denied(request: Request): NextResponse | null {
  if (tokenOk(request.headers.get("x-grabbit-dedupe-token"))) return null;
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

function fail(e: unknown): NextResponse {
  if (e instanceof DedupeError) {
    return NextResponse.json({ error: e.message, fix: e.fix, ...(e.extra || {}) }, { status: e.status });
  }
  console.error("[grabbit-dedupe]", e);
  // 422, not 5xx: a proxy in front may replace a 5xx body with its own page.
  return NextResponse.json({ error: (e as Error)?.message || "Dedupe failed" }, { status: 422 });
}

export async function GET(request: Request, { params }: Params) {
  const no = denied(request);
  if (no) return no;
  const { op } = await params;
  if (op !== "status") return NextResponse.json({ error: "Not found" }, { status: 404 });
  try {
    return NextResponse.json(status(ctx()));
  } catch (e) {
    return fail(e);
  }
}

export async function POST(request: Request, { params }: Params) {
  const no = denied(request);
  if (no) return no;
  const { op } = await params;
  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    body = parsed as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Body must be a JSON object" }, { status: 400 });
  }
  try {
    switch (op) {
      case "lookup":
        return NextResponse.json({ items: lookup(ctx(), body.paths) });
      case "link":
        return NextResponse.json(await link(ctx(), body));
      case "opstatus":
        return NextResponse.json(opStatus(ctx(), body.op));
      case "restore":
        return NextResponse.json(restore(ctx(), body.id, body.uid));
      case "purge":
        return NextResponse.json(await purge(ctx(), body.id, body.uid));
      default:
        return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
  } catch (e) {
    return fail(e);
  }
}
