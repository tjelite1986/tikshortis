import { safeNext } from "@/lib/safe-next";

export const dynamic = "force-dynamic";

/**
 * The sign-in form is drawn by the root layout on any page a signed-out
 * visitor opens, so it signs them in where they stand. This exists so that
 * `/login` is still a real address: pages redirect here when they find no
 * session, and it sends them back to the page they wanted, where the form is.
 */
export function GET(request: Request) {
  const next = safeNext(new URL(request.url).searchParams.get("next"));
  // A relative Location: behind the proxy, request.url carries the container's
  // own address rather than the public one.
  return new Response(null, { status: 302, headers: { location: next } });
}
