// The viewer's sound preference for autoplaying clips.
//
// Per device, in localStorage, like the grid density and the feed's overlay
// toggles: whether a phone may make noise where it is right now is a fact about
// the device and the moment, not about the account, so it does not travel.
//
// Two keys. `start` is what the viewer asked for in Settings > Playback; `last`
// is the state the speaker button was left in, written on every explicit toggle
// regardless of mode so that switching to "last" later picks up a real answer.

export type SoundStart = "muted" | "on" | "last";

export const SOUND_START_KEY = "shorts:sound:start";
export const SOUND_LAST_KEY = "shorts:sound:last";

export const SOUND_START_OPTIONS: readonly {
  value: SoundStart;
  label: string;
  hint: string;
}[] = [
  { value: "muted", label: "Muted", hint: "Clips start silent; tap the speaker for sound." },
  { value: "on", label: "Sound on", hint: "Clips always start with sound." },
  {
    value: "last",
    label: "Last used",
    hint: "Clips start the way you left the speaker button last time.",
  },
];

function isSoundStart(raw: string | null): raw is SoundStart {
  return raw === "muted" || raw === "on" || raw === "last";
}

export function readSoundStart(): SoundStart {
  try {
    const raw = localStorage.getItem(SOUND_START_KEY);
    return isSoundStart(raw) ? raw : "muted";
  } catch {
    return "muted";
  }
}

export function writeSoundStart(value: SoundStart): void {
  try {
    localStorage.setItem(SOUND_START_KEY, value);
  } catch {
    /* private mode — the choice just won't persist */
  }
}

// Whether a fresh feed or grid should start muted, per the preference.
export function initialMuted(): boolean {
  const start = readSoundStart();
  if (start === "on") return false;
  if (start === "muted") return true;
  try {
    return localStorage.getItem(SOUND_LAST_KEY) !== "on";
  } catch {
    return true;
  }
}

// The viewer pressed the speaker button. Only explicit choices land here — a
// browser forcing a clip to start muted is not one.
export function recordSoundChoice(muted: boolean): void {
  try {
    localStorage.setItem(SOUND_LAST_KEY, muted ? "muted" : "on");
  } catch {
    /* preference just won't persist */
  }
}
