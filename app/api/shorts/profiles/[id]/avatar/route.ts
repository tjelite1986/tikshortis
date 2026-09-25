import { createHash } from "node:crypto";
import fs from "node:fs";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { ShortProfileRow } from "@/lib/db";
import { qb, getOne } from "@/lib/kysely";
import { canAccessChannel } from "@/lib/shorts";
import { avatarPathFor } from "@/lib/shorts-storage";

export const dynamic = "force-dynamic";

// Serve a profile's avatar (JPEG, written by scripts/poll-shorts.mjs). Same
// caching contract as the clip poster route: no-cache plus an ETag from the
// file, so a refreshed picture shows up on the next render and an unchanged
// one is a cheap 304.
export async function GET(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const session = await getSession();
  if (!session) return new NextResponse("Unauthorized", { status: 401 });

  const profile = getOne<Pick<ShortProfileRow, "id" | "channel" | "avatar_key">>(
    qb
      .selectFrom("short_profiles")
      .select(["id", "channel", "avatar_key"])
      .where("id", "=", Number(params.id))
  );
  if (!profile || !profile.avatar_key) {
    return new NextResponse("Not found", { status: 404 });
  }
  if (!(await canAccessChannel(profile.channel))) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const filePath = avatarPathFor(profile.channel, profile.avatar_key);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return new NextResponse("Not found", { status: 404 });
  }

  const keyTag = createHash("sha1").update(profile.avatar_key).digest("hex").slice(0, 16);
  const etag = `"${keyTag}-${stat.size}-${Math.floor(stat.mtimeMs)}"`;
  const headers = {
    ETag: etag,
    "Cache-Control": "private, no-cache",
    "X-Content-Type-Options": "nosniff",
  };
  if (request.headers.get("if-none-match") === etag) {
    return new NextResponse(null, { status: 304, headers });
  }

  const stream = fs.createReadStream(filePath);
  return new NextResponse(Readable.toWeb(stream) as unknown as ReadableStream, {
    headers: {
      ...headers,
      "Content-Type": "image/jpeg",
      "Content-Length": String(stat.size),
      "Content-Disposition": "inline",
    },
  });
}
