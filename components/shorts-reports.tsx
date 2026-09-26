"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Loader2, Flag, Check, Trash2 } from "lucide-react";
import { useConfirm } from "@/components/confirm-dialog";
import { REPORT_REASON_LABELS, type ReportReason } from "@/lib/report-reasons";

interface OpenReport {
  reporter: string | null;
  reason: string;
  note: string | null;
  created_at: string;
}

interface ReportedShort {
  id: number;
  caption: string | null;
  profile_name: string | null;
  uploader_name: string | null;
  has_poster: boolean;
  poster_v: string | null;
  report_count: number;
  latest_at: string;
  reports: OpenReport[];
}

function reasonLabel(reason: string): string {
  return (
    (REPORT_REASON_LABELS as Record<string, string>)[reason as ReportReason] ??
    reason
  );
}

// Admin tool (Settings > Reports): every clip a viewer flagged, with the
// reasons and notes, and the two answers an admin has — dismiss the reports
// (the clip stays) or delete the clip (the same soft-delete as the player's
// own Delete). Nothing here is automatic: a report is a request to look.
export default function ShortsReports() {
  const [items, setItems] = useState<ReportedShort[] | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [confirmDialog, confirmAsk] = useConfirm();

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/shorts/reports");
      if (!res.ok) throw new Error(String(res.status));
      const d = (await res.json()) as { items: ReportedShort[] };
      setItems(d.items);
    } catch {
      setItems([]);
      setMsg("Could not load the reports.");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const dismiss = async (id: number) => {
    if (busy !== null) return;
    setBusy(id);
    setMsg(null);
    try {
      const res = await fetch("/api/admin/shorts/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shortId: id, action: "dismiss" }),
      });
      if (res.ok) setItems((prev) => prev?.filter((s) => s.id !== id) ?? null);
      else setMsg("Could not dismiss the reports.");
    } catch {
      setMsg("Network error.");
    }
    setBusy(null);
  };

  const remove = async (s: ReportedShort) => {
    if (busy !== null) return;
    const ok = await confirmAsk({
      title: "Delete this clip?",
      message:
        "The video and its file are removed for everyone. This can't be undone.",
    });
    if (!ok) return;
    setBusy(s.id);
    setMsg(null);
    try {
      const res = await fetch(`/api/shorts/${s.id}`, { method: "DELETE" });
      if (res.ok) {
        // Close the reports too, so the clip's history reads as handled rather
        // than as open reports on a clip that no longer shows.
        await fetch("/api/admin/shorts/reports", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ shortId: s.id, action: "dismiss" }),
        }).catch(() => null);
        setItems((prev) => prev?.filter((x) => x.id !== s.id) ?? null);
      } else {
        setMsg("Could not delete the clip.");
      }
    } catch {
      setMsg("Network error.");
    }
    setBusy(null);
  };

  return (
    <section className="rounded-2xl bg-white/5 p-4 ring-1 ring-white/10">
      {confirmDialog}
      <div className="flex items-center gap-2">
        <Flag size={18} className="text-white/60" />
        <h2 className="text-base font-medium">Reports</h2>
        {items && items.length > 0 && (
          <span className="ml-auto rounded-full bg-rose-500/20 px-2.5 py-0.5 text-xs font-semibold text-rose-300">
            {items.length} open
          </span>
        )}
      </div>
      <p className="mb-3 mt-1 text-sm text-white/50">
        Clips viewers flagged from the player menu. A report also hides the clip
        from that viewer&apos;s feed. Dismiss keeps the clip; Delete removes it
        for everyone.
      </p>
      {items === null ? (
        <p className="flex items-center gap-2 text-sm text-white/50">
          <Loader2 size={16} className="animate-spin" /> Loading…
        </p>
      ) : items.length === 0 ? (
        <p className="text-sm text-white/50">No open reports.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {items.map((s) => (
            <li key={s.id} className="rounded-xl bg-white/5 p-3">
              <div className="flex gap-3">
                <Link
                  href={`/?focus=${s.id}`}
                  className="block h-24 w-16 shrink-0 overflow-hidden rounded-lg bg-black"
                >
                  {s.has_poster ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={`/api/shorts/${s.id}/poster?v=${s.poster_v ?? "2"}`}
                      alt=""
                      className="h-full w-full object-cover"
                    />
                  ) : null}
                </Link>
                <div className="min-w-0 flex-1">
                  <Link
                    href={`/?focus=${s.id}`}
                    className="block truncate text-sm font-medium hover:underline"
                  >
                    {s.caption?.trim() || `Clip #${s.id}`}
                  </Link>
                  <p className="truncate text-xs text-white/50">
                    {s.profile_name ?? s.uploader_name ?? "Unknown creator"} ·{" "}
                    {s.report_count === 1
                      ? "1 report"
                      : `${s.report_count} reports`}
                  </p>
                  <ul className="mt-2 flex flex-col gap-1">
                    {s.reports.map((r, i) => (
                      <li key={i} className="text-xs text-white/70">
                        <span className="font-medium text-white/90">
                          {reasonLabel(r.reason)}
                        </span>
                        {r.reporter && (
                          <span className="text-white/50"> · {r.reporter}</span>
                        )}
                        {r.note && (
                          <span className="block text-white/60">
                            “{r.note}”
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
              <div className="mt-3 flex gap-2">
                <button
                  onClick={() => dismiss(s.id)}
                  disabled={busy !== null}
                  className="flex items-center gap-1.5 rounded-full bg-white/10 px-3.5 py-1.5 text-sm transition hover:bg-white/15 disabled:opacity-40"
                >
                  <Check size={14} /> Dismiss
                </button>
                <button
                  onClick={() => remove(s)}
                  disabled={busy !== null}
                  className="flex items-center gap-1.5 rounded-full bg-red-600/80 px-3.5 py-1.5 text-sm transition hover:bg-red-600 disabled:opacity-40"
                >
                  <Trash2 size={14} /> Delete clip
                </button>
                {busy === s.id && (
                  <Loader2
                    size={16}
                    className="ml-1 self-center animate-spin text-white/60"
                  />
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {msg && <p className="mt-3 text-sm text-white/50">{msg}</p>}
    </section>
  );
}
