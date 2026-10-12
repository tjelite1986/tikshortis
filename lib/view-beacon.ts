"use client";

import { useCallback, useEffect, useRef } from "react";

/** `continued`: see ViewReport in lib/views. */
export type Report = { id: number; watchMs: number; completed: boolean; continued?: boolean };

/**
 * Collects the cards' watch reports and sends them in batches: a few seconds
 * after the first one lands, and at once when the page is hidden (the only
 * reliable moment on a phone). sendBeacon survives navigation; fetch with
 * keepalive is the fallback for browsers without it.
 *
 * Cards report when they stop being active, which a closed tab or a reload
 * never gets to. `live` hands over the active card's progress so far, and is
 * read when the page is hidden.
 */
export function useViewBeacon(enabled: boolean, live?: () => Report | null) {
  const queue = useRef<Report[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const liveRef = useRef(live);
  liveRef.current = live;

  const flush = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (!queue.current.length) return;
    // Latest report per clip wins; the server keeps the max anyway.
    const byId = new Map<number, Report>();
    // A batch that holds a fresh report for a clip still counts one view.
    for (const r of queue.current) {
      const prev = byId.get(r.id);
      byId.set(r.id, prev ? { ...r, continued: !!prev.continued && !!r.continued } : r);
    }
    queue.current = [];
    const body = JSON.stringify({ views: [...byId.values()].slice(-50) });
    try {
      if (!navigator.sendBeacon?.("/api/shorts/views", body)) {
        fetch("/api/shorts/views", { method: "POST", body, keepalive: true }).catch(() => {});
      }
    } catch {
      /* nothing to do with a lost beacon */
    }
  }, []);

  const report = useCallback(
    (id: number, r: { watchMs: number; completed: boolean; continued?: boolean }) => {
      if (!enabled) return;
      queue.current.push({ id, ...r });
      if (!timer.current) timer.current = setTimeout(flush, 4000);
    },
    [enabled, flush]
  );

  useEffect(() => {
    if (!enabled) return;
    const flushWithLive = () => {
      const r = liveRef.current?.();
      if (r) queue.current.push(r);
      flush();
    };
    const onHide = () => {
      if (document.visibilityState === "hidden") flushWithLive();
    };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", flushWithLive);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", flushWithLive);
      flush();
    };
  }, [enabled, flush]);

  return report;
}
