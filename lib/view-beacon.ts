"use client";

import { useCallback, useEffect, useRef } from "react";

type Report = { id: number; watchMs: number; completed: boolean };

/**
 * Collects the cards' watch reports and sends them in batches: a few seconds
 * after the first one lands, and at once when the page is hidden (the only
 * reliable moment on a phone). sendBeacon survives navigation; fetch with
 * keepalive is the fallback for browsers without it.
 */
export function useViewBeacon(enabled: boolean) {
  const queue = useRef<Report[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (!queue.current.length) return;
    // Latest report per clip wins; the server keeps the max anyway.
    const byId = new Map<number, Report>();
    for (const r of queue.current) byId.set(r.id, r);
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
    (id: number, r: { watchMs: number; completed: boolean }) => {
      if (!enabled) return;
      queue.current.push({ id, ...r });
      if (!timer.current) timer.current = setTimeout(flush, 4000);
    },
    [enabled, flush]
  );

  useEffect(() => {
    if (!enabled) return;
    const onHide = () => {
      if (document.visibilityState === "hidden") flush();
    };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", flush);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [enabled, flush]);

  return report;
}
