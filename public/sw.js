/* Tikshortis service worker.
 *
 * Two jobs, both small on purpose:
 *  - being registered at all, which is half of what makes the app installable;
 *  - stale-while-revalidate for poster frames and avatars, so the grids and
 *    the feed's next-clip posters redraw instantly on a revisit.
 *
 * It deliberately never touches video. Clip playback is Range requests against
 * /api/shorts/<id>/video, and a worker that answers those wrongly breaks
 * seeking in ways that look like corrupt files — those requests go straight to
 * the network, as if no worker existed.
 */
const IMG_CACHE = "tikshortis-img-v1";
const IMG_LIMIT = 600;

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) =>
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name !== IMG_CACHE) await caches.delete(name);
      }
      await self.clients.claim();
    })()
  )
);

function isCacheableImage(url) {
  return (
    /^\/api\/shorts\/\d+\/poster$/.test(url.pathname) ||
    /^\/api\/profiles\/[^/]+\/avatar$/.test(url.pathname) ||
    /^\/icon-\d+\.png$/.test(url.pathname)
  );
}

async function trimCache(cache) {
  const keys = await cache.keys();
  const overflow = keys.length - IMG_LIMIT;
  for (let i = 0; i < overflow; i++) await cache.delete(keys[i]);
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  // A Range request for an image is not something this cache can answer: a
  // 206 cannot be stored, and a stored 200 is not what the caller asked for.
  if (req.headers.has("range")) return;

  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;
  if (!isCacheableImage(url)) return;

  // Serve the cached copy instantly, but always refetch in the background and
  // update the cache — a regenerated poster lives at the same URL, so a pure
  // cache-first worker would pin the old frame forever. The routes send an
  // ETag, so an unchanged poster revalidates as a cheap 304.
  event.respondWith(
    (async () => {
      const cache = await caches.open(IMG_CACHE);
      const hit = await cache.match(req);
      const revalidate = fetch(req)
        .then((res) => {
          if (res.ok && res.status === 200) {
            cache.put(req, res.clone());
            trimCache(cache);
          }
          return res;
        })
        .catch(() => null);
      if (hit) {
        event.waitUntil(revalidate);
        return hit;
      }
      const res = await revalidate;
      if (res) return res;
      return new Response("", { status: 504 });
    })()
  );
});
