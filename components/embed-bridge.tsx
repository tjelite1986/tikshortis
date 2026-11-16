"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

/**
 * When the app runs inside Grabbit's hub, tell the hub where it is, so the
 * hub's address follows and a reload or a shared hub link lands on the same
 * page. Only the path is sent, and only to the origins EMBED_FRAME_ANCESTORS
 * allows (the server passes them in); postMessage drops a message whose
 * target origin is not the parent's. Outside a frame this does nothing.
 *
 * Filters change the query with window.history.replaceState and pass Next's
 * own history state along, which Next's router does not sync: no new pathname,
 * no useSearchParams update, no popstate. So while framed, pushState and
 * replaceState are wrapped to report the new address after they run.
 */
export default function EmbedBridge({ origins }: { origins: string[] }) {
  const pathname = usePathname();

  useEffect(() => {
    if (!origins.length || window.parent === window) return;
    let last = "";
    const send = () => {
      const path = window.location.pathname + window.location.search;
      if (path === last) return;
      last = path;
      for (const origin of origins) {
        window.parent.postMessage({ type: "tikshortis:location", path }, origin);
      }
    };
    send();
    const h = window.history;
    const origPush = h.pushState;
    const origReplace = h.replaceState;
    const wrap = (orig: History["pushState"]): History["pushState"] =>
      function (this: History, ...args) {
        const result = orig.apply(this, args);
        queueMicrotask(send);
        return result;
      };
    const push = wrap(origPush);
    const replace = wrap(origReplace);
    h.pushState = push;
    h.replaceState = replace;
    // Back/forward.
    window.addEventListener("popstate", send);
    return () => {
      window.removeEventListener("popstate", send);
      // Only undo our own wrapper; something else may have wrapped it since.
      if (h.pushState === push) h.pushState = origPush;
      if (h.replaceState === replace) h.replaceState = origReplace;
    };
  }, [origins, pathname]);

  return null;
}
