import type { ShortProfileLinkKind } from "./db";

// Shared by the API route (validation), the profile page (deriving the poll
// source into a link) and the client editor (suggesting a kind while typing).
// Pure on purpose: no db import, so it bundles into the browser.

export const LINK_KINDS: readonly ShortProfileLinkKind[] = [
  "tiktok",
  "instagram",
  "youtube",
  "facebook",
  "other",
] as const;

export const LINK_KIND_LABEL: Record<ShortProfileLinkKind, string> = {
  tiktok: "TikTok",
  instagram: "Instagram",
  youtube: "YouTube",
  facebook: "Facebook",
  other: "Other",
};

export const MAX_LINKS_PER_PROFILE = 20;
export const MAX_LINK_URL_LENGTH = 2048;
export const MAX_LINK_LABEL_LENGTH = 60;

export function isLinkKind(value: unknown): value is ShortProfileLinkKind {
  return typeof value === "string" && (LINK_KINDS as readonly string[]).includes(value);
}

// Parse a link the way the editor and the API both accept it: a full http(s)
// URL. Returns null for anything else, so a caller never stores "javascript:".
export function parseLinkUrl(raw: string): URL | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_LINK_URL_LENGTH) return null;
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (!u.hostname) return null;
  return u;
}

// Which platform a URL belongs to, from its host. "other" for anything else —
// including a URL that does not parse, so the caller can still show a guess.
export function kindForUrl(raw: string): ShortProfileLinkKind {
  const u = parseLinkUrl(raw);
  if (!u) return "other";
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const is = (...domains: string[]) =>
    domains.some((d) => host === d || host.endsWith(`.${d}`));
  if (is("tiktok.com")) return "tiktok";
  if (is("instagram.com", "instagr.am")) return "instagram";
  if (is("youtube.com", "youtu.be")) return "youtube";
  if (is("facebook.com", "fb.com", "fb.watch")) return "facebook";
  return "other";
}

// Two spellings of the same page compare equal: host case, "www.", a trailing
// slash and the hash never distinguish a profile.
export function linkUrlKey(raw: string): string {
  const u = parseLinkUrl(raw);
  if (!u) return raw.trim();
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const path = u.pathname.replace(/\/+$/, "");
  return `${host}${path}${u.search}`;
}

// The handle a link points at, for a caption under an icon: "@name" for a
// TikTok/Instagram/YouTube profile URL, the host for anything else.
export function linkCaption(kind: ShortProfileLinkKind, url: string, label: string | null): string {
  if (label && label.trim()) return label.trim();
  const u = parseLinkUrl(url);
  if (!u) return url;
  const first = u.pathname.split("/").filter(Boolean)[0];
  if (first && /^@/.test(first) && kind !== "other") return decodeURIComponent(first);
  if (kind === "instagram" && first) return `@${decodeURIComponent(first)}`;
  return u.hostname.replace(/^www\./, "");
}

// Validates a link body for create and update alike. `existing` is the row
// being updated, so a missing field keeps its current value.
export function readLinkBody(
  body: Record<string, unknown>,
  existing?: { kind: string; url: string; label: string | null }
): { kind: ShortProfileLinkKind; url: string; label: string | null } | { error: string } {
  const rawUrl = typeof body.url === "string" ? body.url : existing?.url ?? "";
  const parsed = parseLinkUrl(rawUrl);
  if (!parsed) return { error: "Link must be a full http(s) URL." };
  const url = rawUrl.trim();

  const kind = isLinkKind(body.kind)
    ? body.kind
    : existing && body.url === undefined
      ? existing.kind
      : kindForUrl(url);
  if (!isLinkKind(kind)) return { error: "Unknown link kind." };

  let label: string | null;
  if (body.label === undefined) label = existing?.label ?? null;
  else if (body.label === null || body.label === "") label = null;
  else if (typeof body.label === "string") label = body.label.trim() || null;
  else return { error: "Label must be text." };
  if (label && label.length > MAX_LINK_LABEL_LENGTH) {
    return { error: `Label must be at most ${MAX_LINK_LABEL_LENGTH} characters.` };
  }
  return { kind, url, label };
}
