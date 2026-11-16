import { contentSecurityPolicy } from "./lib/csp.mjs";

// The full policy with frame-ancestors 'none'. middleware.ts replaces it with
// the same policy plus the configured frame-ancestors on every path it
// matches; this covers the paths it skips (static assets, the upload route).
const CSP = contentSecurityPolicy("frame-ancestors 'none'");

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Standalone: the runner ships server.js plus the traced node_modules only.
  // The maintenance scripts (import/transcode/poll) run inside the container
  // via `docker exec` and need better-sqlite3 and sharp at runtime — both are
  // imported by lib/, so the trace carries them. ffmpeg comes from apt.
  output: "standalone",
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
