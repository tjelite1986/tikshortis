import ShortsGrid from "@/components/shorts-grid";
import { getSession } from "@/lib/auth";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

// What the viewer has watched, most recent first. Written by the player's
// beacon; a clip left after a moment counts too, so this is "opened", not
// "finished". Tapping a tile opens the feed there.
export default async function HistoryPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  return (
    <div className="mx-auto max-w-5xl px-2 pb-24 pt-6">
      <h1 className="mb-3 px-1 text-lg font-semibold text-white">History</h1>
      <ShortsGrid
        query={{ channel: "main", sort: "history" }}
        hrefPrefix="/?focus="
        empty="Nothing watched yet."
        restoreKey="history"
      />
    </div>
  );
}
