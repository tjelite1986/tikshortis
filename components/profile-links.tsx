"use client";

import { useState } from "react";
import { Facebook, Instagram, Link as LinkIcon, Pencil, Trash2, Youtube } from "lucide-react";
import type { ShortProfileLinkKind } from "@/lib/db";
import type { ProfileLink } from "@/lib/shorts";
import { LINK_KINDS, LINK_KIND_LABEL, kindForUrl, linkCaption } from "@/lib/profile-links";
import { useBackDismiss } from "@/lib/use-back-dismiss";
import { useConfirm } from "@/components/confirm-dialog";
import { cn } from "@/lib/utils";

// lucide has no TikTok glyph; this is the plain note outline on a 24 grid.
function TikTokIcon({ size = 20 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M16.6 5.82a4.28 4.28 0 0 1-1.03-2.8h-3.1v12.4a2.6 2.6 0 1 1-2.6-2.6c.27 0 .53.04.78.12V9.77a5.7 5.7 0 1 0 4.92 5.65V9.04a7.35 7.35 0 0 0 4.3 1.38V7.32a4.3 4.3 0 0 1-3.27-1.5Z" />
    </svg>
  );
}

function KindIcon({ kind, size = 20 }: { kind: ShortProfileLinkKind; size?: number }) {
  switch (kind) {
    case "tiktok":
      return <TikTokIcon size={size} />;
    case "instagram":
      return <Instagram size={size} />;
    case "youtube":
      return <Youtube size={size} />;
    case "facebook":
      return <Facebook size={size} />;
    default:
      return <LinkIcon size={size} />;
  }
}

// The social-link row under a profile header: one round icon per link, the
// handle or label as a caption. Admins get a pencil that opens the editor; the
// list is kept locally and replaced with whatever the API returns, so the row
// updates without a page reload.
export default function ProfileLinks({
  profileId,
  links: initial,
  isAdmin,
}: {
  profileId: number;
  links: ProfileLink[];
  isAdmin: boolean;
}) {
  const [links, setLinks] = useState(initial);
  const [editing, setEditing] = useState(false);

  if (links.length === 0 && !isAdmin) return null;

  return (
    <>
      <div className="flex flex-wrap items-start justify-center gap-x-2 gap-y-3">
        {links.map((l) => (
          <a
            key={l.id ?? `source:${l.url}`}
            href={l.url}
            target="_blank"
            rel="noopener noreferrer"
            title={l.url}
            className="flex w-[4.5rem] flex-col items-center gap-1 text-center"
          >
            <span className="flex h-11 w-11 items-center justify-center rounded-full bg-white/10 text-white transition active:scale-90">
              <KindIcon kind={l.kind} />
            </span>
            <span className="w-full truncate text-[11px] leading-tight text-white/60">
              {linkCaption(l.kind, l.url, l.label)}
            </span>
          </a>
        ))}
        {isAdmin && (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="flex w-[4.5rem] flex-col items-center gap-1 text-center"
            aria-label="Edit links"
          >
            <span className="flex h-11 w-11 items-center justify-center rounded-full border border-dashed border-white/25 text-white/60 transition active:scale-90">
              <Pencil size={18} />
            </span>
            <span className="text-[11px] leading-tight text-white/40">
              {links.length ? "Edit" : "Add link"}
            </span>
          </button>
        )}
      </div>
      {editing && (
        <LinksEditor
          profileId={profileId}
          links={links}
          onChange={setLinks}
          onClose={() => setEditing(false)}
        />
      )}
    </>
  );
}

const inputClass =
  "w-full rounded-xl bg-white/10 px-4 py-2.5 text-sm placeholder-white/40 focus:outline-none focus:ring-2 focus:ring-white/30";

function LinksEditor({
  profileId,
  links,
  onChange,
  onClose,
}: {
  profileId: number;
  links: ProfileLink[];
  onChange: (links: ProfileLink[]) => void;
  onClose: () => void;
}) {
  const [url, setUrl] = useState("");
  // The kind follows the URL while the admin has not picked one by hand: a
  // pasted tiktok.com link is TikTok without a second tap, and "other" stays
  // settable for a platform the detector does not know.
  const [pickedKind, setPickedKind] = useState<ShortProfileLinkKind | null>(null);
  const kind = pickedKind ?? kindForUrl(url);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDialog, confirmAsk] = useConfirm();
  useBackDismiss(true, onClose);

  const call = async (path: string, init: RequestInit) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(path, init);
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(d.error || "Could not save.");
        return false;
      }
      if (Array.isArray(d.links)) onChange(d.links);
      return true;
    } catch {
      setError("Could not reach the server.");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    if (busy) return;
    const ok = await call(`/api/shorts/profiles/${profileId}/links`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, kind, label: kind === "other" ? label : "" }),
    });
    if (ok) {
      setUrl("");
      setLabel("");
      setPickedKind(null);
    }
  };

  const remove = async (l: ProfileLink) => {
    if (busy || l.id === null) return;
    const ok = await confirmAsk({
      title: "Remove this link?",
      message: linkCaption(l.kind, l.url, l.label),
      confirmLabel: "Remove",
    });
    if (!ok) return;
    await call(`/api/shorts/profiles/${profileId}/links/${l.id}`, { method: "DELETE" });
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-black/60"
      onClick={onClose}
    >
      {confirmDialog}
      <div
        className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-t-2xl bg-neutral-900 p-5 pb-8 text-white"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="mb-3 text-base font-semibold">Social links</p>

        {links.length > 0 && (
          <ul className="mb-4 divide-y divide-white/10 rounded-xl border border-white/10">
            {links.map((l) => (
              <li key={l.id ?? `source:${l.url}`} className="flex items-center gap-3 px-3 py-2.5">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/10">
                  <KindIcon kind={l.kind} size={16} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">
                    {linkCaption(l.kind, l.url, l.label)}
                  </span>
                  <span className="block truncate text-xs text-white/40">{l.url}</span>
                </span>
                {l.from_source ? (
                  <span className="shrink-0 rounded-full bg-white/10 px-2 py-0.5 text-[10px] text-white/50">
                    poll source
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => remove(l)}
                    disabled={busy}
                    className="shrink-0 rounded-full p-1.5 text-white/50 transition hover:bg-white/10 hover:text-rose-400 disabled:opacity-50"
                    aria-label="Remove link"
                  >
                    <Trash2 size={16} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}

        <label className="mb-1 block text-xs text-white/50">Add a link</label>
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://www.instagram.com/…"
          inputMode="url"
          autoComplete="off"
          className={cn(inputClass, "mb-2")}
        />
        <div className="mb-2 flex flex-wrap gap-1.5">
          {LINK_KINDS.map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setPickedKind(k)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition",
                kind === k
                  ? "border-white/60 bg-white/15"
                  : "border-white/15 text-white/60 hover:bg-white/10"
              )}
            >
              <KindIcon kind={k} size={13} />
              {LINK_KIND_LABEL[k]}
            </button>
          ))}
        </div>
        {kind === "other" && (
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Label, e.g. Linktree"
            maxLength={60}
            className={cn(inputClass, "mb-2")}
          />
        )}

        {error && <p className="mb-2 text-sm text-rose-400">{error}</p>}
        <div className="mt-2 flex gap-3">
          <button
            type="button"
            onClick={add}
            disabled={busy || !url.trim()}
            className="flex-1 rounded-full bg-rose-500 py-2.5 text-sm font-semibold transition active:scale-95 disabled:opacity-50"
          >
            {busy ? "Saving…" : "Add"}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-full bg-white/10 py-2.5 text-sm font-semibold transition active:scale-95"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
