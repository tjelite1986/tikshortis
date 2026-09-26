"use client";

import { useEffect, useState } from "react";

/**
 * Settings > Playback: the clips the viewer marked "Not interested".
 *
 * Per account, not per device (the list lives in the database). There is no
 * browsable list on purpose — the row in the player menu and the Undo toast
 * cover the single-clip case; this card is the way back when the list has
 * grown past remembering.
 */
export default function HiddenClipsSettings() {
  const [count, setCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/shorts/hidden")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d) setCount(Number(d.count));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const restoreAll = async () => {
    if (busy || !count) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/shorts/hidden", { method: "DELETE" });
      if (res.ok) {
        setCount(0);
        setMsg("All clips are back in your feed.");
      } else {
        setMsg("Could not restore the clips.");
      }
    } catch {
      setMsg("Network error.");
    }
    setBusy(false);
  };

  return (
    <section className="rounded-2xl bg-white/5 p-4 ring-1 ring-white/10">
      <h2 className="text-base font-medium">Not interested</h2>
      <p className="mb-3 mt-1 text-sm text-white/50">
        Clips you marked Not interested stay out of every feed and grid, except
        Liked, your playlists and Mine. Saved on your account.
      </p>
      <div className="flex items-center gap-3">
        <span className="text-sm text-white/70">
          {count === null
            ? "…"
            : count === 1
              ? "1 clip hidden"
              : `${count} clips hidden`}
        </span>
        <button
          onClick={restoreAll}
          disabled={busy || !count}
          className="ml-auto rounded-full bg-white/5 px-3.5 py-1.5 text-sm text-white/60 transition hover:text-white/90 disabled:opacity-40 disabled:hover:text-white/60"
        >
          Show them again
        </button>
      </div>
      {msg && <p className="mt-3 text-sm text-white/50">{msg}</p>}
    </section>
  );
}
