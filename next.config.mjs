// Tikshortis is self-hosted end to end: video, posters and avatars are all
// served by this app's own routes. The only cross-origin call the browser makes
// is to the sign-in host (elite-v2), and that is a redirect, not a fetch.
// 'unsafe-inline' script/style is required by Next's hydration payload and by
// Tailwind's injected styles.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "frame-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/** @type {import('next').NextConfig} */
const nextConfig = {
  // No "output: standalone". The maintenance scripts (import/transcode/poll)
  // run inside this container via `docker exec` and need better-sqlite3, sharp
  // and ffmpeg at runtime; Next only traces its own server, so the image ships
  // the full production node_modules instead. Same shape as elite-v2.
  reactStrictMode: true,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: CSP },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
