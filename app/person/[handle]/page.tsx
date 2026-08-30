import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { getSession } from "@/lib/auth";
import { personContentIds, getGroupMembers } from "@/lib/people";
import ShortsGrid from "@/components/shorts-grid";

export const dynamic = "force-dynamic";

/**
 * Everything one person's handle covers: their creator profile's clips and, if
 * the handle is also an account here, that account's own uploads.
 *
 * elite-v2 answered this at /people/<handle>, a page that also carried their
 * photos, posts and long-form videos. Only the clips came with the extraction,
 * so this is the same scope minus the tabs that had nothing behind them.
 */
export default async function PersonPage(props: {
  params: Promise<{ handle: string }>;
}) {
  const params = await props.params;
  const session = await getSession();
  if (!session) redirect("/login");

  const handle = decodeURIComponent(params.handle);
  const ids = personContentIds(handle);
  // An empty group is nobody. It must not fall through to a grid with no
  // filter, which would quietly show the whole library under one person's name.
  if (ids.shortsIds.length === 0 && ids.userIds.length === 0) notFound();

  const members = getGroupMembers(handle).filter(
    (m) => m !== handle.toLowerCase()
  );

  return (
    <div className="mx-auto max-w-5xl px-2 pb-24 pt-6 text-white">
      <div className="mb-4 flex items-center gap-2 px-1">
        <Link
          href="/profiles"
          className="rounded-full bg-white/10 p-1.5 transition active:scale-90"
          aria-label="Back"
        >
          <ChevronLeft size={18} />
        </Link>
        <div className="flex-1">
          <div className="text-lg font-semibold">@{handle}</div>
          {members.length > 0 && (
            <div className="text-xs text-white/50">
              also {members.map((m) => `@${m}`).join(", ")}
            </div>
          )}
        </div>
      </div>

      <ShortsGrid
        query={{ handle }}
        hrefPrefix={`/person/${encodeURIComponent(handle)}/watch?focus=`}
        empty="No clips for this person yet."
        adminActions={session.role === "admin"}
        channel="main"
        lengthFilter
      />
    </div>
  );
}
