"use client";

import { useState } from "react";
import { LogIn, Play } from "lucide-react";

const INPUT_CLS =
  "w-full rounded-full border border-white/15 bg-white/5 px-4 py-2.5 text-sm text-white outline-none placeholder:text-white/40 focus:border-rose-400";

/**
 * What a visitor without a session sees, on whatever page they opened.
 *
 * The form is here rather than on a page of its own so a link to a clip or a
 * profile signs the visitor in where they stand: a successful sign-in reloads
 * the same address, which the layout then renders signed in. There is no
 * sign-up next to it — accounts are made with scripts/users.cjs.
 */
export default function SignedOut() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (res.ok) {
        // A full load, not router.refresh: the layout decided "signed out" on
        // the server, and everything under it hangs off that.
        window.location.reload();
        return;
      }
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      setError(body?.error ?? `Sign-in failed (HTTP ${res.status})`);
    } catch {
      setError("Could not reach the server");
    }
    setBusy(false);
  }

  return (
    <main className="flex min-h-[100dvh] flex-col items-center justify-center px-6 text-center text-white">
      <span className="mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-white/10">
        <Play size={30} className="text-rose-400" />
      </span>
      <h1 className="text-2xl font-semibold">Tikshortis</h1>
      <p className="mt-2 max-w-xs text-sm text-white/60">Sign in to watch.</p>
      <form onSubmit={submit} className="mt-6 flex w-full max-w-xs flex-col gap-3">
        <input
          type="email"
          autoComplete="username"
          placeholder="Email"
          required
          className={INPUT_CLS}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <input
          type="password"
          autoComplete="current-password"
          placeholder="Password"
          required
          className={INPUT_CLS}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && <p className="text-xs text-red-400">{error}</p>}
        <button
          type="submit"
          disabled={busy}
          className="mt-1 flex items-center justify-center gap-2 rounded-full bg-rose-500 px-6 py-2.5 text-sm font-semibold text-white transition active:scale-95 disabled:opacity-60"
        >
          <LogIn size={16} /> {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}
