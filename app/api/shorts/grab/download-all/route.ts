import { getSession, sameOriginPage } from "@/lib/auth";
import { grabbitFetch } from "@/lib/grabbit";
import { CHANNEL } from "@/lib/shorts";

export const dynamic = "force-dynamic";
export const maxDuration = 600;

// Proxy to the grabbit grabber: batch-download a profile's clips into the channel's
// import folder, streaming Server-Sent Events progress through. Admin only.
// EventSource can only GET, so the CSRF proof lives here (see download/).
export async function GET(req: Request) {
  const session = await getSession();
  if (!session || session.role !== "admin") {
    return new Response("Forbidden", { status: 403 });
  }
  if (!sameOriginPage(req)) {
    return new Response("Bad origin", { status: 403 });
  }
  const sp = new URL(req.url).searchParams;
  const qs = new URLSearchParams({
    url: sp.get("url") || "",
    channel: CHANNEL,
  });
  if (sp.get("ids")) qs.set("ids", sp.get("ids") as string);
  if (sp.get("creator")) qs.set("creator", sp.get("creator") as string);
  if (sp.get("web") === "1") qs.set("web", "1");
  if (sp.get("quality")) qs.set("quality", sp.get("quality") as string);

  let upstream: Response;
  try {
    upstream = await grabbitFetch(`/api/download-all?${qs.toString()}`, 600_000);
  } catch {
    return new Response("data: " + JSON.stringify({ type: "error", error: "Grabber unreachable" }) + "\n\n", {
      headers: { "Content-Type": "text/event-stream" },
    });
  }
  if (!upstream.ok || !upstream.body) {
    // Report it as an event rather than piping a non-SSE error body through
    // with a 200 and a text/event-stream label.
    return new Response(
      "data: " + JSON.stringify({ type: "error", error: `Grabber answered ${upstream.status}` }) + "\n\n",
      { headers: { "Content-Type": "text/event-stream" } },
    );
  }
  return new Response(upstream.body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
