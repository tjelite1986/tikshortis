"use client";

// The three bottom sheets the short card opens: comments, share and
// save-to-playlist. They only ever render from short-card.tsx; they live here
// so that file stays about the card itself.

import { useEffect, useState } from "react";
import { X, Send, Bookmark, Plus, Link2 } from "lucide-react";
import { cn } from "@/lib/utils";

interface Comment {
  id: number;
  body: string;
  author_name: string | null;
  created_at: string;
}

export function CommentsSheet({
  shortId,
  onClose,
  onCountChange,
}: {
  shortId: number;
  onClose: () => void;
  onCountChange: (n: number) => void;
}) {
  const [comments, setComments] = useState<Comment[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/shorts/${shortId}/comments`)
      .then((r) => r.json())
      .then((d) => setComments(d.comments || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [shortId]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const body = input.trim();
    if (!body) return;
    setInput("");
    try {
      const res = await fetch(`/api/shorts/${shortId}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      });
      if (res.ok) {
        const d = await res.json();
        // Update the parent outside the updater: React may run an updater
        // during render (twice in StrictMode), and a setState on another
        // component from there is a warning at best and a double count at worst.
        const next = [...comments, d.comment];
        setComments(next);
        onCountChange(next.length);
      }
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end" onClick={onClose}>
      <div
        className="flex max-h-[70%] flex-col rounded-t-2xl bg-neutral-900 text-white"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
          <span className="font-semibold">
            {comments.length} comment{comments.length === 1 ? "" : "s"}
          </span>
          <button onClick={onClose} aria-label="Close">
            <X size={20} />
          </button>
        </div>
        <div className="flex-1 space-y-4 overflow-y-auto px-4 py-3">
          {loading && <p className="text-sm text-white/50">Loading…</p>}
          {!loading && comments.length === 0 && (
            <p className="text-sm text-white/50">Be the first to comment.</p>
          )}
          {comments.map((c) => (
            <div key={c.id} className="text-sm">
              <span className="font-semibold">@{c.author_name ?? "Unknown"}</span>{" "}
              <span className="text-white/90">{c.body}</span>
            </div>
          ))}
        </div>
        <form
          onSubmit={submit}
          className="flex items-center gap-2 border-t border-white/10 p-3"
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Add a comment…"
            className="flex-1 rounded-full bg-white/10 px-4 py-2 text-sm placeholder-white/40 focus:outline-none focus:ring-2 focus:ring-white/30"
          />
          <button
            type="submit"
            aria-label="Post comment"
            className="rounded-full bg-rose-500 p-2 transition active:scale-90"
          >
            <Send size={18} />
          </button>
        </form>
      </div>
    </div>
  );
}

export function ShareSheet({
  shortId,
  onClose,
}: {
  shortId: number;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  // elite-v2's sheet also listed every account, to send the clip as a direct
  // message. That went with the extraction: this app has no inbox to deliver
  // one to, and a Send button that quietly does nothing is worse than not
  // offering it. Sharing is the link — the system share sheet where there is
  // one, the clipboard otherwise.
  const shareExternal = async () => {
    const url = `${window.location.origin}/?focus=${shortId}`;
    if (navigator.share) {
      try {
        await navigator.share({ url });
        return;
      } catch {
        /* dismissed — fall through to copy */
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end" onClick={onClose}>
      <div
        className="flex flex-col rounded-t-2xl bg-neutral-900 text-white"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
          <span className="font-semibold">Share</span>
          <button onClick={onClose} aria-label="Close">
            <X size={20} />
          </button>
        </div>
        <button
          onClick={shareExternal}
          className="mx-2 my-2 flex items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition hover:bg-white/5"
        >
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-white/10">
            <Link2 size={17} />
          </span>
          {copied ? "Link copied!" : "Copy link / share"}
        </button>
      </div>
    </div>
  );
}

interface SavePlaylist {
  id: number;
  name: string;
  item_count: number;
  contains: number;
}

// Save-to-playlist ("Favorites") picker: toggle the clip into any of the user's
// playlists, or create a new one.
export function SaveSheet({
  shortId,
  onClose,
  onSavedChange,
}: {
  shortId: number;
  onClose: () => void;
  onSavedChange: (saved: boolean) => void;
}) {
  const [playlists, setPlaylists] = useState<SavePlaylist[]>([]);
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    const res = await fetch(`/api/shorts/playlists?short=${shortId}`);
    if (res.ok) {
      const pls: SavePlaylist[] = (await res.json()).playlists || [];
      setPlaylists(pls);
      onSavedChange(pls.some((p) => !!p.contains));
    }
    setLoading(false);
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = async (p: SavePlaylist) => {
    const inIt = !!p.contains;
    const next = playlists.map((x) =>
      x.id === p.id
        ? { ...x, contains: inIt ? 0 : 1, item_count: x.item_count + (inIt ? -1 : 1) }
        : x
    );
    setPlaylists(next);
    // The bookmark is yellow whenever the clip is in at least one playlist.
    onSavedChange(next.some((x) => !!x.contains));
    await fetch(`/api/shorts/playlists/${p.id}/items` + (inIt ? `?short=${shortId}` : ""), {
      method: inIt ? "DELETE" : "POST",
      headers: { "Content-Type": "application/json" },
      body: inIt ? undefined : JSON.stringify({ shortId }),
    });
  };

  const createAndAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) return;
    setName("");
    const res = await fetch("/api/shorts/playlists", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: n }),
    });
    if (res.ok) {
      const { playlist } = await res.json();
      await fetch(`/api/shorts/playlists/${playlist.id}/items`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shortId }),
      });
      refresh();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end" onClick={onClose}>
      <div
        className="flex max-h-[70%] flex-col rounded-t-2xl bg-neutral-900 text-white"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
          <span className="font-semibold">Save to playlist</span>
          <button onClick={onClose} aria-label="Close">
            <X size={20} />
          </button>
        </div>
        <form onSubmit={createAndAdd} className="flex gap-2 border-b border-white/10 p-3">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="New playlist…"
            className="flex-1 rounded-full bg-white/10 px-4 py-2 text-sm placeholder-white/40 focus:outline-none focus:ring-2 focus:ring-white/30"
          />
          <button
            type="submit"
            aria-label="Create playlist"
            className="rounded-full bg-rose-500 p-2 transition active:scale-90"
          >
            <Plus size={18} />
          </button>
        </form>
        <div className="flex-1 overflow-y-auto px-2 py-2">
          {loading && <p className="px-2 text-sm text-white/50">Loading…</p>}
          {!loading && playlists.length === 0 && (
            <p className="px-2 text-sm text-white/50">
              No playlists yet — create one above.
            </p>
          )}
          {playlists.map((p) => (
            <button
              key={p.id}
              onClick={() => toggle(p)}
              className="flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-left hover:bg-white/5"
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">{p.name}</span>
                <span className="text-xs text-white/50">{p.item_count} clips</span>
              </span>
              <Bookmark
                size={20}
                className={cn(p.contains ? "fill-rose-500 text-rose-500" : "text-white/40")}
              />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
