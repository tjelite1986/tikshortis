import { NextResponse } from "next/server";
import { readFileSync } from "fs";
import path from "path";

export const dynamic = "force-dynamic";

let cached: string | null = null;

// Current build id. Installed PWAs poll this when they come back to the
// foreground to notice a new deployment and reload themselves: Android resumes
// a suspended app instance rather than reloading it, so without this check an
// installed app can keep running week-old code after a deploy.
//
// Unauthenticated by design — it exposes nothing but an opaque build hash, and
// an app that cannot check its own version while signed out is an app that
// never updates its login screen.
export async function GET() {
  if (!cached) {
    try {
      cached = readFileSync(
        path.join(process.cwd(), ".next", "BUILD_ID"),
        "utf8"
      ).trim();
    } catch {
      cached = "dev";
    }
  }
  return NextResponse.json({ build: cached });
}
