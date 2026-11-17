import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { CHANNEL, getShortTags } from "@/lib/shorts";

export const dynamic = "force-dynamic";

// The hashtag catalogue the /tags page renders, for clients outside this app.
// Same privacy rule as the page: others' private clips are not counted.
export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const tags = getShortTags(CHANNEL, Number(session.sub) || 0, session.role === "admin");
  return NextResponse.json({ tags });
}
