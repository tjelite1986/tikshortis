import { NextResponse } from "next/server";
import { getSession, sameOrigin } from "@/lib/auth";
import { getShort } from "@/lib/shorts";
import { handOverTo18Plus, handoverConfigured } from "@/lib/handover";

export const dynamic = "force-dynamic";

/**
 * Hand a clip over to elite-v2's 18+ library (the uploader of their own clip, or
 * an admin).
 *
 * This used to be a channel move inside one app. The 18+ library now lives in
 * elite-v2, so the clip is dropped into that app's import folder and picked up
 * by its own timer — see lib/handover.ts. The route keeps its name and its
 * `{ channel: "18plus" }` body so the button that calls it did not have to learn
 * a new shape, but there is only one direction: nothing comes back the other
 * way except through elite-v2's own tools.
 */
export async function PATCH(
  request: Request,
  props: { params: Promise<{ id: string }> }
) {
  const params = await props.params;
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!sameOrigin(request)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }

  const short = getShort(Number(params.id));
  if (!short) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const isOwner = short.uploader_id === Number(session.sub);
  if (session.role !== "admin" && !isOwner) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  if (body?.channel !== "18plus") {
    return NextResponse.json(
      { error: "The only move from here is to the 18+ library." },
      { status: 400 }
    );
  }
  if (!handoverConfigured()) {
    return NextResponse.json(
      { error: "The 18+ library is not reachable from here." },
      { status: 503 }
    );
  }

  try {
    const result = handOverTo18Plus(short.id);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }
    // The clip is on the other side but not yet visible there: elite-v2's
    // importer runs every 5 minutes and its transcoder every 3. Say so, rather
    // than let it read as a clip that vanished.
    return NextResponse.json({
      ok: true,
      channel: "18plus",
      message: "Handed over — it appears in the 18+ library within a few minutes.",
    });
  } catch (err) {
    console.error("[shorts] handover to the 18+ library failed:", err);
    return NextResponse.json({ error: "Handover failed." }, { status: 500 });
  }
}
