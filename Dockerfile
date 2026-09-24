# Multi-stage build.
#
# better-sqlite3 and sharp are native modules, so they are compiled once, in the
# deps stage, against this image's own glibc — never copied in from the host.
# The runner ships Next's standalone trace: the server plus exactly the
# node_modules it imports. That trace already includes better-sqlite3 and sharp
# (lib/ imports both), which is all the maintenance scripts in scripts/*.mjs
# need when the host timers run them here with `docker exec`.

FROM node:22-slim AS deps
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-slim AS runner
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

# The standalone trace lands server.js, package.json, next.config.mjs and the
# pruned node_modules at /app. Static assets and public/ are not part of the
# trace and are copied beside it, where the server expects them.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --chown=nextjs:nodejs scripts ./scripts

USER nextjs
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS -o /dev/null http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "server.js"]
