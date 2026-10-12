import ShortsGrid from "@/components/shorts-grid";
import { getSession } from "@/lib/auth";
import { parseShortsLength } from "@/lib/shorts";

export const dynamic = "force-dynamic";

// Browse all clips as a grid; tapping one opens the immersive feed there.
export default async function ExplorePage(props: {
  searchParams: Promise<{ length?: string; unseen?: string }>;
}) {
  const [session, searchParams] = await Promise.all([getSession(), props.searchParams]);
  return (
    <div className="mx-auto max-w-5xl px-2 pb-24 pt-6">
      <ShortsGrid
        query={{ channel: "main" }}
        hrefPrefix="/?focus="
        empty="Nothing to explore yet."
        restoreKey="explore:main"
        lengthFilter
        initialLength={parseShortsLength(searchParams.length ?? null)}
        initialUnseen={searchParams.unseen === "1"}
        isAdmin={session?.role === "admin"}
      />
    </div>
  );
}
