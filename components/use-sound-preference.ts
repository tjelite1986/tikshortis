"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { initialMuted, recordSoundChoice } from "@/lib/sound-prefs";

/**
 * The shared mute flag of a feed or grid, seeded from the viewer's preference
 * (Settings > Playback) and written back on every press of a speaker button.
 *
 * Seeded POST-MOUNT like every localStorage-backed preference here: the server
 * cannot know it, and a useState initializer that read it would make SSR and
 * hydration disagree. The first clip only starts once its IntersectionObserver
 * has fired, which is after this effect has run.
 *
 * `soundBlocked` is for the player. A browser refuses to start a clip with
 * sound until the viewer has touched the page (a cold load, a PWA launch), and
 * the player then falls back to muted. The flag follows so the speaker icon
 * tells the truth; the stored preference is left alone, because the viewer did
 * not choose this; and the wanted sound comes back on the first pointer-down
 * that is not the speaker button itself — that button must toggle from what it
 * shows, or a viewer tapping "unmute" would end up muted and have that saved.
 */
export function useSoundPreference(): {
  muted: boolean;
  setMutedByUser: (muted: boolean) => void;
  toggleMuted: () => void;
  soundBlocked: () => void;
} {
  const [muted, setMuted] = useState(true);
  const mutedRef = useRef(muted);
  mutedRef.current = muted;
  // Removes the one-shot restore listener, when one is armed.
  const disarmRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    setMuted(initialMuted());
  }, []);

  const disarm = useCallback(() => {
    disarmRef.current?.();
    disarmRef.current = null;
  }, []);
  useEffect(() => disarm, [disarm]);

  const setMutedByUser = useCallback(
    (next: boolean) => {
      disarm();
      setMuted(next);
      recordSoundChoice(next);
    },
    [disarm]
  );

  const toggleMuted = useCallback(() => {
    setMutedByUser(!mutedRef.current);
  }, [setMutedByUser]);

  const soundBlocked = useCallback(() => {
    if (disarmRef.current) return;
    setMuted(true);
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target instanceof Element ? e.target : null;
      if (target?.closest("[data-sound-toggle]")) return;
      disarmRef.current?.();
      disarmRef.current = null;
      setMuted(false);
    };
    // Capture phase, so a handler that stops propagation cannot hide the
    // gesture from us.
    document.addEventListener("pointerdown", onPointerDown, true);
    disarmRef.current = () =>
      document.removeEventListener("pointerdown", onPointerDown, true);
  }, []);

  return { muted, setMutedByUser, toggleMuted, soundBlocked };
}

// Whether a rejected play() is the browser's autoplay gate rather than a
// missing codec or a play() interrupted by pause(). Only the gate is worth a
// muted retry.
export function isAutoplayBlocked(err: unknown): boolean {
  return err instanceof DOMException && err.name === "NotAllowedError";
}
