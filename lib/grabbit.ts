// The grabbit grabber: one place for its address, its credential and the
// timeout every proxy call gets. grabbit's internal API trusts a request that
// carries the token AND arrives without a proxy header, so the address is the
// LAN port, never the public hostname.

const GRABBIT =
  process.env.GRABBIT_URL || process.env.LADDA_URL || "http://grabbit:3000";

const HEADERS = { "x-grabbit-token": process.env.GRABBIT_INTERNAL_TOKEN || "" };

// Resolving and listing a profile can legitimately take a minute (yt-dlp on
// the other side); a batch download streams for as long as it needs, so its
// caller passes its own bound.
const DEFAULT_TIMEOUT_MS = 120_000;

export function grabbitFetch(
  pathAndQuery: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  return fetch(`${GRABBIT}${pathAndQuery}`, {
    headers: HEADERS,
    signal: AbortSignal.timeout(timeoutMs),
  });
}

// The failure shape every grab caller reads. Served with 200 on purpose:
// Cloudflare replaces a 5xx body with its own HTML page, so the client would
// parse "<!DOCTYPE" instead of this.
export const UNREACHABLE = { ok: false, error: "Grabber unreachable" } as const;
