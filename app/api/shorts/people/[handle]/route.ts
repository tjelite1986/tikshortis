import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { handleOf } from "@/lib/handle";
import { getGroupMembers, personContentIds } from "@/lib/people";

export const dynamic = "force-dynamic";

// The header of the /person/<handle> page: whether the handle is anybody, and
// the other handles grouped with it. The clips themselves come from
// /api/shorts/feed?handle=<handle>.
export async function GET(_req: Request, props: { params: Promise<{ handle: string }> }) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let raw: string;
  try {
    raw = decodeURIComponent((await props.params).handle).slice(0, 200);
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const ids = personContentIds(raw);
  // An empty group is nobody (see the page): never a grid of everything.
  if (ids.shortsIds.length === 0 && ids.userIds.length === 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const handle = handleOf(raw);
  return NextResponse.json({
    person: {
      handle,
      members: getGroupMembers(raw).filter((m) => m !== handle),
      profileIds: ids.shortsIds,
      hasAccount: ids.userIds.length > 0,
    },
  });
}
