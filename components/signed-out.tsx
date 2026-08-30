import Link from "next/link";
import { Play } from "lucide-react";

/**
 * What a visitor without a session sees.
 *
 * Sign-in belongs to elite-v2 — this app has no accounts of its own — so there
 * is nothing to fill in here, only a door. It is a page rather than a redirect
 * because "you are signed out" and "the sign-in host could not be reached" are
 * different situations, and bouncing every cold load through another host would
 * report the second one as the first.
 */
export default function SignedOut({
  loginHref,
  configured,
}: {
  loginHref: string;
  configured: boolean;
}) {
  return (
    <main className="flex min-h-[100dvh] flex-col items-center justify-center px-6 text-center text-white">
      <span className="mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-white/10">
        <Play size={30} className="text-rose-400" />
      </span>
      <h1 className="text-2xl font-semibold">Tikshortis</h1>
      {configured ? (
        <>
          <p className="mt-2 max-w-xs text-sm text-white/60">
            Sign in with your Elite account to watch.
          </p>
          <Link
            href={loginHref}
            className="mt-6 rounded-full bg-rose-500 px-6 py-2.5 text-sm font-semibold text-white transition active:scale-95"
          >
            Sign in
          </Link>
        </>
      ) : (
        <p className="mt-2 max-w-xs text-sm text-white/60">
          Sign-in is not configured on this server yet.
        </p>
      )}
    </main>
  );
}
