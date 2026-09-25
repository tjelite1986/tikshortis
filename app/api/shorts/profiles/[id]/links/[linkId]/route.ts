import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { db, ShortProfileLinkRow, ShortProfileRow } from "@/lib/db";
import { qb, getOne } from "@/lib/kysely";
import { CHANNEL, getProfileLinks } from "@/lib/shorts";
import { linkUrlKey, readLinkBody } from "@/lib/profile-links";

export const dynamic = "force-dynamic";

// One stored link. The derived poll-source link has no row and therefore no
// id, so it can never reach here: it is edited through the profile's
// source_ref instead.

async function load(params: { id: string; linkId: string }) {
  const session = await getSession();
  if (!session) return { error: "Unauthorized", status: 401 as const };
  if (session.role !== "admin") return { error: "Forbidden", status: 403 as const };
  const profile = getOne<ShortProfileRow>(
    qb.selectFrom("short_profiles").selectAll().where("id", "=", Number(params.id))
  );
  if (!profile || profile.channel !== CHANNEL) return { error: "Not found", status: 404 as const };
  const link = getOne<ShortProfileLinkRow>(
    qb
      .selectFrom("short_profile_links")
      .selectAll()
      .where("id", "=", Number(params.linkId))
      .where("profile_id", "=", profile.id)
  );
  if (!link) return { error: "Not found", status: 404 as const };
  return { profile, link };
}

export async function PATCH(
  request: Request,
  props: { params: Promise<{ id: string; linkId: string }> }
) {
  const found = await load(await props.params);
  if ("error" in found) return NextResponse.json({ error: found.error }, { status: found.status });
  const { profile, link } = found;

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const next = readLinkBody(body, link);
  if ("error" in next) return NextResponse.json({ error: next.error }, { status: 400 });

  const key = linkUrlKey(next.url);
  const clash = getProfileLinks(profile).some(
    (l) => l.id !== link.id && linkUrlKey(l.url) === key
  );
  if (clash) {
    return NextResponse.json({ error: "That link is already on the profile." }, { status: 409 });
  }

  db.prepare("UPDATE short_profile_links SET kind = ?, url = ?, label = ? WHERE id = ?").run(
    next.kind,
    next.url,
    next.label,
    link.id
  );
  return NextResponse.json({ ok: true, links: getProfileLinks(profile) });
}

export async function DELETE(
  _request: Request,
  props: { params: Promise<{ id: string; linkId: string }> }
) {
  const found = await load(await props.params);
  if ("error" in found) return NextResponse.json({ error: found.error }, { status: found.status });
  const { profile, link } = found;
  db.prepare("DELETE FROM short_profile_links WHERE id = ?").run(link.id);
  return NextResponse.json({ ok: true, links: getProfileLinks(profile) });
}
