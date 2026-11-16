"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

/**
 * When the app runs inside Grabbit's hub, tell the hub where it is, so the
 * hub's address follows and a reload or a shared hub link lands on the same
 * page. Only the path is sent, and only to the origins EMBED_FRAME_ANCESTORS
 * allows (the server passes them in); postMessage drops a message whose
 * target origin is not the parent's. Outside a frame this does nothing.
 */
export default function EmbedBridge({ origins }: { origins: string[] }) {
  const pathname = usePathname();

  useEffect(() => {
    if (!origins.length || window.parent === window) return;
    const send = () => {
      const path = window.location.pathname + window.location.search;
      for (const origin of origins) {
        window.parent.postMessage({ type: "tikshortis:location", path }, origin);
      }
    };
    send();
    // Search-only changes (a filter) do not change the pathname.
    window.addEventListener("popstate", send);
    return () => window.removeEventListener("popstate", send);
  }, [origins, pathname]);

  return null;
}
