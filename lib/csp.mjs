// The app's Content-Security-Policy, in one place.
//
// Plain .mjs so that next.config.mjs (loaded by Node, not the bundler) and
// middleware.ts can both import it.
//
// Tikshortis is self-hosted end to end: video, posters and avatars are all
// served by this app's own routes. 'unsafe-inline' script/style is required by
// Next's hydration payload and by Tailwind's injected styles.
//
// Why one header and not two: a Content-Security-Policy header set in
// middleware REPLACES the one next.config.mjs sends for the same response,
// even with headers.append(). Verified on the 2.2 candidate: the response
// carried only `frame-ancestors ...` and the rest of the policy was gone.
// So middleware sends the whole policy, and next.config.mjs keeps sending it
// (with frame-ancestors 'none') for the paths middleware does not match.

export const BASE_DIRECTIVES = [
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
];

/**
 * @param {string} frameAncestorsDirective e.g. "frame-ancestors 'none'"
 * @returns {string}
 */
export function contentSecurityPolicy(frameAncestorsDirective) {
  return [...BASE_DIRECTIVES, frameAncestorsDirective].join("; ");
}
