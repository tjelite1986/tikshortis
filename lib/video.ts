import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

// Video helpers, lifted unchanged from elite-v2's lib/gallery-storage.ts when
// Shorts moved out. Only the video half came along: this app has no image
// gallery, so the EXIF/HEIC/thumbnail machinery stayed behind.

const VIDEO_EXTS = new Set(["mp4", "mov", "m4v", "webm", "3gp", "avi", "mkv"]);

const VIDEO_MIME: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  "3gp": "video/3gpp",
  avi: "video/x-msvideo",
  mkv: "video/x-matroska",
};

export function isSupportedVideo(filename: string, mime: string): boolean {
  const ext = (path.extname(filename).slice(1) || "").toLowerCase();
  return VIDEO_EXTS.has(ext) || mime.startsWith("video/");
}


// --- Content sniffing -------------------------------------------------------
// The extension and the claimed MIME type are both CLAIMS from the source, so
// isSupportedVideo() alone cannot tell a video from a web page. A download that
// hits a login wall, a captcha or an error page comes back as HTML with HTTP 200
// and gets written under whatever filename was asked for: that is how a 311 KB
// Facebook checkpoint page once became short #1336, wearing a .mp4 name and a
// video/mp4 mime, and only surfaced hours later as a transcoder failure.
// Sniffing the container signature catches it at the door instead.
const MAGIC_BYTES = 16;

// ISO base media / QuickTime files normally lead with "ftyp", but a leading
// free/skip/wide/pnot atom or a bare moov/mdat is legal too (older .mov files
// especially), so accept the whole box-type family rather than ftyp alone.
const ISO_BOX_TYPES = new Set(["ftyp", "moov", "mdat", "free", "skip", "wide", "pnot"]);

// Returns the detected container name, or null if the bytes are not video.
export function sniffVideoContainer(head: Buffer): string | null {
  if (head.length >= 12 && ISO_BOX_TYPES.has(head.toString("latin1", 4, 8))) {
    return "iso-bmff"; // mp4 / m4v / mov / 3gp
  }
  // EBML header -> Matroska / WebM
  if (
    head.length >= 4 &&
    head[0] === 0x1a &&
    head[1] === 0x45 &&
    head[2] === 0xdf &&
    head[3] === 0xa3
  ) {
    return "matroska";
  }
  if (
    head.length >= 12 &&
    head.toString("latin1", 0, 4) === "RIFF" &&
    head.toString("latin1", 8, 12) === "AVI "
  ) {
    return "avi";
  }
  return null;
}

// Image signatures, for the gallery side where an ingest may legitimately be a
// picture. AVIF/HEIC/HEIF are ISO-BMFF containers like mp4, so they lead with
// "ftyp" and are covered by the box-type check rather than a magic of their own.

function describeNonMedia(head: Buffer): string {
  const text = head.toString("latin1").trimStart().toLowerCase();
  if (text.startsWith("<!doctype") || text.startsWith("<html") || text.startsWith("<?xml")) {
    return "an HTML page (usually a login wall, captcha or error page served instead of the file)";
  }
  if (text.startsWith("{") || text.startsWith("[")) return "a JSON response";
  if (head.length === 0) return "an empty file";
  return "no recognised container signature";
}

// Read just the leading bytes, from a Buffer or without slurping a multi-GB file.
function readHead(source: Buffer | string): Buffer {
  if (typeof source !== "string") return source.subarray(0, MAGIC_BYTES);
  const fd = fs.openSync(source, "r");
  try {
    const buf = Buffer.alloc(MAGIC_BYTES);
    const read = fs.readSync(fd, buf, 0, MAGIC_BYTES, 0);
    return buf.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

// Throws unless the first bytes really are a video container. Accepts the same
// Buffer-or-path source shape as the storage helpers so it can run BEFORE the
// bytes are copied into place.
export function assertRealVideo(source: Buffer | string, filename: string): void {
  const head = readHead(source);
  if (!sniffVideoContainer(head)) {
    throw new Error(`${filename} is not a video file — got ${describeNonMedia(head)}`);
  }
}


// one (e.g. the folder importer passes an empty mime).
export function videoMimeFor(filename: string): string {
  return VIDEO_MIME[getExt(filename)] || "video/mp4";
}

export function getExt(filename: string): string {
  return (path.extname(filename).slice(1) || "bin").toLowerCase();
}

// HEIC/HEIF (iPhone) — sharp's bundled libvips can't decode it, so these need
// converting via heif-convert before any sharp processing. Decided from the
// FILE BYTES, not the extension/mime: downloads are often mislabeled (e.g.
// gallery-dl writes Instagram JPEGs as .heic), and trusting the name either

export interface VideoMeta {
  takenAt: Date | null;
  latitude: number | null;
  longitude: number | null;
  width: number | null;
  height: number | null;
}

// Probe a video for dimensions, capture date and (Apple) GPS via ffprobe. Reads
// from a file path because ffprobe can't take a buffer. Honours rotation
// side-data so portrait clips report upright dimensions.
export function readVideoMeta(filePath: string): VideoMeta {
  const meta: VideoMeta = {
    takenAt: null,
    latitude: null,
    longitude: null,
    width: null,
    height: null,
  };
  try {
    const out = execFileSync(
      "ffprobe",
      [
        "-v",
        "quiet",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        filePath,
      ],
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = JSON.parse(out);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const v = (data.streams || []).find((s: any) => s.codec_type === "video");
    if (v) {
      if (typeof v.width === "number") meta.width = v.width;
      if (typeof v.height === "number") meta.height = v.height;
      const rot = Math.abs(
        Number(v.tags?.rotate ?? v.side_data_list?.[0]?.rotation ?? 0)
      );
      if ((rot === 90 || rot === 270) && meta.width && meta.height) {
        [meta.width, meta.height] = [meta.height, meta.width];
      }
    }
    const tags = { ...(data.format?.tags || {}), ...(v?.tags || {}) };
    const created =
      tags.creation_time || tags["com.apple.quicktime.creationdate"];
    if (created) {
      const d = new Date(created);
      if (
        !isNaN(d.getTime()) &&
        d.getUTCFullYear() >= 1995 &&
        d.getTime() <= Date.now() + 86400000
      ) {
        meta.takenAt = d;
      }
    }
    const loc =
      tags.location ||
      tags["com.apple.quicktime.location.ISO6709"] ||
      tags["location-eng"];
    if (typeof loc === "string") {
      // ISO 6709, e.g. "+58.3654+012.3386+086.500/"
      const m = loc.match(/([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)/);
      if (m) {
        const lat = parseFloat(m[1]);
        const lon = parseFloat(m[2]);
        if (
          Math.abs(lat) <= 90 &&
          Math.abs(lon) <= 180 &&
          !(lat === 0 && lon === 0)
        ) {
          meta.latitude = lat;
          meta.longitude = lon;
        }
      }
    }
  } catch {
    /* ffprobe missing or unreadable */
  }
  return meta;
}

// Extract a single poster frame as a JPEG buffer for thumb/preview generation.
// Seeks ~1s in (skips black intro frames); falls back to the very start for
// sub-second clips.
export function extractVideoPoster(filePath: string): Buffer {
  const tmpOut = path.join(os.tmpdir(), `${randomUUID()}.jpg`);
  const run = (seek: string): boolean => {
    try {
      execFileSync(
        "ffmpeg",
        ["-y", "-ss", seek, "-i", filePath, "-frames:v", "1", "-q:v", "3", tmpOut],
        { stdio: "ignore" }
      );
    } catch {
      /* checked by output size below */
    }
    return fs.existsSync(tmpOut) && fs.statSync(tmpOut).size > 0;
  };
  try {
    if (!run("1") && !run("0")) {
      throw new Error("ffmpeg produced no poster frame");
    }
    return fs.readFileSync(tmpOut);
  } finally {
    try {
      if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut);
    } catch {
      /* best effort */
    }
  }
}
