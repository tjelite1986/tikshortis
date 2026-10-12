import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { getSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { canAccessChannel, parseChannel } from "@/lib/shorts";
import type { ShortChannel } from "@/lib/db";
import {
  channelDir,
  ensureDir,
  storeShortUpload,
  profileFromFilename,
  renameShortFiles,
} from "@/lib/shorts-storage";
import { getExt } from "@/lib/video";
import { uploadStem } from "@/lib/import-naming";

export const dynamic = "force-dynamic";

// Formats browsers can play as-is, so the clip is shown immediately and the
// transcoder (v1b) only optimizes it later. Everything else stays 'pending'
// until transcoded to .web.mp4 so the feed never serves an unplayable file.
const WEB_PLAYABLE = new Set(["mp4", "m4v", "webm"]);
// Streamed uploads go straight to disk, so the cap is a disk bound, not a
// memory bound. Shorts are a few tens of MB; this leaves room for a raw phone
// recording.
const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;
// A multipart body is parsed into memory by the runtime before this code sees
// it, so that form is kept only for small files and old clients.
const MAX_MULTIPART_BYTES = 64 * 1024 * 1024;
// How many uploads one process stores at a time. Each one runs ffprobe and
// ffmpeg; on a small box more in parallel only makes all of them slower.
const MAX_CONCURRENT = 2;
let inFlight = 0;
// The only error texts a client gets to see; anything else (ENOSPC, EACCES,
// a path) is logged and replaced.
const CLIENT_SAFE_ERRORS = new Set(["Unsupported file type — videos only"]);

class TooLargeError extends Error {}

function fromThisHost(request: Request): boolean {
  const host = request.headers.get("host");
  for (const value of [request.headers.get("origin"), request.headers.get("referer")]) {
    if (!value) continue;
    try {
      return !!host && new URL(value).host === host;
    } catch {
      /* malformed: treated as absent */
    }
  }
  return false;
}

/** Counts bytes through and fails the stream past the cap. */
function byteCap(max: number): Transform {
  let total = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      total += chunk.length;
      if (total > max) cb(new TooLargeError("too large"));
      else cb(null, chunk);
    },
  });
}

/** Decodes a header the client wrote with encodeURIComponent. */
function headerText(request: Request, name: string): string {
  const raw = request.headers.get(name) ?? "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

type Incoming = {
  name: string;
  type: string;
  caption: string;
  channel: ShortChannel;
  isPrivate: 0 | 1;
  // Either the whole file (multipart) or a temp path the body was streamed to.
  source: Buffer | string;
};

// Raw body: the file is the body, the fields travel in headers. Written to a
// temp file under the channel's own store, so placing it is a link, not a copy.
async function readRawUpload(request: Request): Promise<Incoming | NextResponse> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_UPLOAD_BYTES) {
    return NextResponse.json({ error: "File too large." }, { status: 413 });
  }
  if (!request.body) {
    return NextResponse.json({ error: "No file uploaded." }, { status: 400 });
  }
  const name = headerText(request, "x-upload-name").trim();
  if (!name) {
    return NextResponse.json({ error: "No file uploaded." }, { status: 400 });
  }
  const channel = parseChannel(headerText(request, "x-upload-channel") || "main");
  if (!(await canAccessChannel(channel))) {
    return NextResponse.json({ error: "Locked" }, { status: 403 });
  }
  const incoming = path.join(channelDir(channel), ".incoming");
  ensureDir(incoming);
  const tmp = path.join(incoming, `${randomUUID()}${path.extname(name).slice(0, 16)}`);
  try {
    await pipeline(
      Readable.fromWeb(request.body as WebReadableStream),
      byteCap(MAX_UPLOAD_BYTES),
      fs.createWriteStream(tmp, { flags: "wx" })
    );
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    if (err instanceof TooLargeError) {
      return NextResponse.json({ error: "File too large." }, { status: 413 });
    }
    throw err;
  }
  return {
    name,
    type: request.headers.get("content-type") ?? "",
    caption: headerText(request, "x-upload-caption").trim().slice(0, 2000),
    channel,
    // New uploads are PRIVATE by default — only "public" shares to everyone.
    isPrivate: headerText(request, "x-upload-visibility") === "public" ? 0 : 1,
    source: tmp,
  };
}

// Multipart form, as older clients send it. The runtime has already buffered
// the whole body by the time formData() returns, hence the lower cap, checked
// against Content-Length before the body is read at all.
async function readFormUpload(request: Request): Promise<Incoming | NextResponse> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_MULTIPART_BYTES) {
    return NextResponse.json({ error: "File too large." }, { status: 413 });
  }
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No file uploaded." }, { status: 400 });
  }
  if (file.size > MAX_MULTIPART_BYTES) {
    return NextResponse.json({ error: "File too large." }, { status: 413 });
  }
  const channel = parseChannel(String(form.get("channel") || "main"));
  if (!(await canAccessChannel(channel))) {
    return NextResponse.json({ error: "Locked" }, { status: 403 });
  }
  return {
    name: file.name,
    type: file.type,
    caption: String(form.get("caption") || "").trim().slice(0, 2000),
    channel,
    isPrivate: String(form.get("visibility") || "private") === "public" ? 0 : 1,
    source: Buffer.from(await file.arrayBuffer()),
  };
}

// Upload one short. Uploading to the 18+ channel requires an unlocked gate, so
// you can't seed that channel without the PIN.
export async function POST(request: Request) {
  // Not covered by middleware (see its matcher), so its CSRF check is here,
  // against the Host header as middleware does: request.url carries the
  // server's own bind address in the standalone build.
  if (!fromThisHost(request)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = Number(session.sub);

  if (inFlight >= MAX_CONCURRENT) {
    return NextResponse.json(
      { error: "Too many uploads in progress. Try again in a moment." },
      { status: 429, headers: { "Retry-After": "10" } }
    );
  }
  inFlight++;
  let tmpPath: string | null = null;
  try {
    const isForm = (request.headers.get("content-type") ?? "").startsWith("multipart/form-data");
    const incoming = isForm ? await readFormUpload(request) : await readRawUpload(request);
    if (incoming instanceof NextResponse) return incoming;
    if (typeof incoming.source === "string") tmpPath = incoming.source;
    const { name, type, caption, channel, isPrivate, source } = incoming;

    try {
      // Clips live in the channel's own store (<SHORTS_ROOT>/<channel>/), with a
      // readable filename. A "profilname_-_title.mp4" filename lands in that
      // creator's subfolder; anything else falls back to a shared folder inside
      // storeShortUpload, so a clip is never stored loose in the channel root.
      const subdir = profileFromFilename(name) ?? undefined;
      const stored = await storeShortUpload(channel, caption, name, type, source, subdir, {
        move: true,
      });

      const status = WEB_PLAYABLE.has(getExt(name)) ? "ready" : "pending";

      const result = db
        .prepare(
          `INSERT INTO shorts
             (channel, uploader_id, caption, storage_key, poster_key, mime_type,
              width, height, duration, size_bytes, source, status, is_private)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'upload', ?, ?)`
        )
        .run(
          channel,
          userId,
          caption || null,
          stored.storageKey,
          stored.posterKey,
          stored.mimeType,
          stored.width,
          stored.height,
          stored.duration,
          stored.sizeBytes,
          status,
          isPrivate
        );

      const shortId = Number(result.lastInsertRowid);
      // Rename to the canonical self-describing name now that we know the id.
      try {
        const renamed = renameShortFiles(
          channel,
          stored.storageKey,
          stored.posterKey,
          uploadStem(name, caption, shortId, "clip")
        );
        db.prepare("UPDATE shorts SET storage_key = ?, poster_key = ? WHERE id = ?").run(
          renamed.storageKey,
          renamed.posterKey,
          shortId
        );
      } catch {
        /* keep the original stored name if the rename fails */
      }

      return NextResponse.json({ ok: true, id: shortId });
    } catch (err) {
      console.error("[shorts] upload failed:", err);
      const message =
        err instanceof Error && CLIENT_SAFE_ERRORS.has(err.message)
          ? err.message
          : "Failed to process upload";
      return NextResponse.json({ error: message }, { status: 400 });
    }
  } finally {
    inFlight--;
    // Gone already when the store moved it; still here after a refused file.
    if (tmpPath) fs.rmSync(tmpPath, { force: true });
  }
}
