import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { db, ShortProfileRow } from "@/lib/db";
import { qb, getOne } from "@/lib/kysely";
import { CHANNEL, getProfileLinks } from "@/lib/shorts";
import { MAX_LINKS_PER_PROFILE, linkUrlKey, readLinkBody } from "@/lib/profile-links";

export const dynamic = "force-dynamic";

// A profile's social links. Reading is for any signed-in user (the page
// renders them server-side; this is what the editor refreshes from), writing
// is admin only. The poll source is never stored here — getProfileLinks
// derives it — so a POST for the same page is refused as a duplicate.

function loadProfile(id: string): ShortProfileRow | undefined {
  const profile = getOne<ShortProfileRow>(
    qb.selectFrom("short_profiles").selectAll().where("id", "=", Number(id))
  );
  // A profile on another channel belongs to another app's library.
  if (!profile || profile.channel !== CHANNEL) return undefined;
  return profile;
}

export async function GET(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const profile = loadProfile(params.id);
  if (!profile) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ links: getProfileLinks(profile) });
}

export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const profile = loadProfile(params.id);
  if (!profile) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const link = readLinkBody(body);
  if ("error" in link) return NextResponse.json({ error: link.error }, { status: 400 });

  const current = getProfileLinks(profile);
  if (current.filter((l) => !l.from_source).length >= MAX_LINKS_PER_PROFILE) {
    return NextResponse.json(
      { error: `A profile can have at most ${MAX_LINKS_PER_PROFILE} links.` },
      { status: 400 }
    );
  }
  const key = linkUrlKey(link.url);
  if (current.some((l) => linkUrlKey(l.url) === key)) {
    return NextResponse.json({ error: "That link is already on the profile." }, { status: 409 });
  }

  db.prepare(
    "INSERT INTO short_profile_links (profile_id, kind, url, label) VALUES (?, ?, ?, ?)"
  ).run(profile.id, link.kind, link.url, link.label);

  return NextResponse.json({ ok: true, links: getProfileLinks(profile) });
}
