# Multi-stage build. better-sqlite3 and sharp are native modules, so they are
# compiled inside the image against its own glibc — never copied in from the
# host. The production stage ships the full prod node_modules (not Next's
# standalone trace) because scripts/*.mjs run in this container on host timers
# and need better-sqlite3, sharp and ffmpeg at runtime.

FROM node:20-slim AS deps
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

FROM node:20-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:20-slim AS prod-deps
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

FROM node:20-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
ENV DATA_DIR=/app/data

# ffmpeg/ffprobe: the transcoder, poster frames and the duplicate scanner's
# frame decoding. curl/ca-certificates: the grab resolver and the auto-poller
# fetching a remote clip. yt-dlp itself is bind-mounted (YT_DLP_BIN) so it can
# be updated on the host without rebuilding the image.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs \
  && mkdir -p /app/data && chown -R nextjs:nodejs /app

COPY --from=prod-deps --chown=nextjs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nextjs:nodejs /app/.next ./.next
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --chown=nextjs:nodejs package.json next.config.mjs ./
COPY --chown=nextjs:nodejs scripts ./scripts

USER nextjs
EXPOSE 3000
CMD ["./node_modules/.bin/next", "start"]
