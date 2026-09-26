"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import {
  SOUND_START_OPTIONS,
  readSoundStart,
  writeSoundStart,
  type SoundStart,
} from "@/lib/sound-prefs";

/**
 * Settings > Playback: how clips start on this device.
 *
 * The choice is read post-mount (see useGridCols for why), so the control
 * renders on the default for a frame before snapping to the saved value.
 */
export default function PlaybackSettings() {
  const [start, setStart] = useState<SoundStart>("muted");

  useEffect(() => {
    setStart(readSoundStart());
  }, []);

  const choose = (value: SoundStart) => {
    setStart(value);
    writeSoundStart(value);
  };

  const current = SOUND_START_OPTIONS.find((o) => o.value === start);

  return (
    <section className="rounded-2xl bg-white/5 p-4 ring-1 ring-white/10">
      <h2 className="text-base font-medium">Sound</h2>
      <p className="mb-3 mt-1 text-sm text-white/50">
        How clips start playing. Saved on this device only.
      </p>
      <div role="radiogroup" aria-label="Start clips" className="flex gap-1.5">
        {SOUND_START_OPTIONS.map((o) => (
          <button
            key={o.value}
            role="radio"
            aria-checked={o.value === start}
            onClick={() => choose(o.value)}
            className={cn(
              "rounded-full px-3.5 py-1.5 text-sm transition",
              o.value === start
                ? "bg-rose-500 font-semibold text-white"
                : "bg-white/5 text-white/60 hover:text-white/90"
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
      {current && (
        <p className="mt-3 text-sm text-white/50">{current.hint}</p>
      )}
      <p className="mt-3 text-xs text-white/40">
        Browsers only allow sound after you have touched the page. When the app
        is opened cold the first clip starts muted, and sound comes on at your
        first tap.
      </p>
    </section>
  );
}
