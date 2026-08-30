import { notFound, redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { CHANNEL, getProfileSummary } from "@/lib/shorts";
import ShortsFeed from "@/components/shorts-feed";

export const dynamic = "force-dynamic";

// Immersive feed scoped to one profile (opened from the profile grid).
export default async function ProfileWatchPage(
  props: {
    params: Promise<{ id: string }>;
    searchParams: Promise<{ focus?: string }>;
  }
) {
  const searchParams = await props.searchParams;
  const params = await props.params;
  const session = await getSession();
  if (!session) redirect("/login");

  const profile = getProfileSummary(Number(params.id));
  if (!profile) notFound();
  // A profile on another channel belongs to elite-v2's library, not this one.
  if (profile.channel !== CHANNEL) notFound();

  const focus = Number(searchParams?.focus);
  return (
    <ShortsFeed
      channel={profile.channel}
      profileId={profile.id}
      focusId={focus && !isNaN(focus) ? focus : undefined}
      isAdmin={session.role === "admin"}
      viewerId={Number(session?.sub) || 0}
    />
  );
}
