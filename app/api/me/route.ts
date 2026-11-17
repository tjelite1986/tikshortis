import { NextResponse } from "next/server";
import { getSession, handleFor } from "@/lib/auth";
import { getUserPermissions, hasShortsPermission, PERMISSION_KEYS } from "@/lib/permissions";

export const dynamic = "force-dynamic";

// Who the session belongs to. The app's own pages read this server-side; a
// client that renders TikShortis elsewhere (Grabbit's native hub pages, via its
// gateway) needs it as an API. Only the viewer's own account, never anyone
// else's.
export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const id = Number(session.sub);
  const isAdmin = session.role === "admin";
  return NextResponse.json(
    {
      user: {
        id,
        email: session.email,
        role: session.role,
        username: session.username,
        displayName: session.displayName,
        avatarUrl: session.avatarUrl,
        handle: handleFor({ username: session.username, email: session.email }),
        // Admins hold every permission implicitly (see lib/permissions.ts).
        permissions: isAdmin ? [...PERMISSION_KEYS] : getUserPermissions(id),
        canTools: hasShortsPermission(session),
      },
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
