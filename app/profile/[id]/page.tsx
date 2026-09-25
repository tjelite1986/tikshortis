import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ChevronLeft, Download } from "lucide-react";
import { getSession } from "@/lib/auth";
import { CHANNEL, getProfileLinks, getProfileSummary } from "@/lib/shorts";
import ShortsGrid from "@/components/shorts-grid";
import ProfileLinks from "@/components/profile-links";

export const dynamic = "force-dynamic";

function initials(name: string): string {
  const s = name.replace(/[^a-zA-Z0-9]/g, "");
  return (s.slice(0, 2) || "?").toUpperCase();
}

function compact(n: number): string {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

// A single profile, laid out like a TikTok/Instagram profile: a centred
// avatar, the handle, a stats row, the creator's social links, then the grid
// of clips. Tapping a clip opens the immersive feed scoped to this profile,
// starting there.
export default async function ShortsProfilePage(
  props: {
    params: Promise<{ id: string }>;
  }
) {
  const params = await props.params;
  const session = await getSession();
  if (!session) redirect("/login");

  const profile = getProfileSummary(Number(params.id));
  if (!profile) notFound();

  // A profile on another channel belongs to elite-v2's library, not this one.
  if (profile.channel !== CHANNEL) notFound();

  const isAdmin = session.role === "admin";
  const links = getProfileLinks(profile);

  return (
    <div className="mx-auto max-w-5xl px-2 pb-24 pt-4 text-white">
      <div className="mb-2 flex items-center justify-between px-1">
        <Link
          href="/profiles"
          className="rounded-full bg-white/10 p-1.5 transition active:scale-90"
          aria-label="Back"
        >
          <ChevronLeft size={18} />
        </Link>
        {isAdmin && (
          <Link
            href={`/profile/${profile.id}/candidates`}
            className="flex items-center gap-1.5 rounded-full bg-rose-500 px-4 py-2 text-sm font-semibold transition active:scale-95"
          >
            <Download size={16} /> Download
          </Link>
        )}
      </div>

      <div className="mb-6 flex flex-col items-center gap-3 px-3">
        {profile.avatar_key ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`/api/shorts/profiles/${profile.id}/avatar?v=${encodeURIComponent(profile.avatar_checked_at ?? "")}`}
            alt=""
            className="h-24 w-24 rounded-full object-cover ring-2 ring-white/15"
          />
        ) : (
          <span
            aria-hidden="true"
            className="flex h-24 w-24 items-center justify-center rounded-full bg-gradient-to-br from-rose-500/70 to-purple-600/70 text-2xl font-semibold ring-2 ring-white/15"
          >
            {initials(profile.name)}
          </span>
        )}
        <h1 className="max-w-full truncate text-xl font-semibold">@{profile.name}</h1>
        <div className="flex items-center gap-6 text-center">
          <div>
            <div className="text-base font-semibold leading-tight">{compact(profile.clip_count)}</div>
            <div className="text-xs text-white/50">{profile.clip_count === 1 ? "Clip" : "Clips"}</div>
          </div>
          <div>
            <div className="text-base font-semibold leading-tight">{compact(profile.like_count)}</div>
            <div className="text-xs text-white/50">{profile.like_count === 1 ? "Like" : "Likes"}</div>
          </div>
        </div>
        <ProfileLinks profileId={profile.id} links={links} isAdmin={isAdmin} />
      </div>

      <ShortsGrid
        query={{ profile: String(profile.id) }}
        hrefPrefix={`/profile/${profile.id}/watch?focus=`}
        empty="No clips for this profile yet."
        adminActions={isAdmin}
        channel="main"
        lengthFilter
      />
    </div>
  );
}
