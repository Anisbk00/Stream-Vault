import type { NextConfig } from "next";

/**
 * Security headers applied to ALL responses — including API routes.
 *
 * NOTE: Next.js 16 deprecated middleware in favor of "proxy" convention.
 * All security headers are set here via next.config.ts headers(),
 * which reliably applies to ALL responses regardless of response origin.
 *
 * Routes that need different values (e.g., embed proxy needs
 * X-Frame-Options: ALLOWALL) override these in their own response.
 */

const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(self), geolocation=(), payment=()' },
  { key: 'X-DNS-Prefetch-Control', value: 'on' },
  { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
];

/**
 * Content-Security-Policy for page responses.
 *
 * Constraints:
 *  - Inline scripts in layout.tsx (dangerouslySetInnerHTML) → 'unsafe-inline' required
 *  - External embed iframes (rotating domains) → permissive frame-src
 *  - Google Fonts (Geist) → font-src + style-src
 *  - TMDB images + Supabase storage → img-src
 *  - Supabase auth (REST + WebSocket) → connect-src
 *  - Avatar upload: fetch(dataURL) to convert compressed data URLs → data: blob: in connect-src
 *  - Service worker → worker-src
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' https://image.tmdb.org https://*.supabase.co data: blob:",
  "frame-src 'self' https://vidapi.ru https://vidapi.domains https://vidapi.to https://vidapi.bz https://vidapi.me https://vidapi.tw https://vaplayer.ru https://streamdata.vaplayer.ru https://vidsrc.to https://vidsrc.me https://vidsrc.pm https://vidsrc.cc https://vidsrcme.ru https://vidsrcme.su https://vidsrc-embed.ru https://vidsrc-embed.su https://vidsrc-me.ru https://vidsrc-me.su https://vsrc.su https://embed.su https://2embed.cc https://www.2embed.cc https://multiembed.mov https://playembed.site https://embed.filmu.in https://justhd.tv https://tmstrd.justhd.tv https://vsembed.ru https://nextgencloudfabric.com https://cloudorchestranova.com https://vidsrc.icu https://vidsrc.xyz https://vidsrc.net https://vidsrc.cc https://autoembed.co https://autoembed.to https://cloneembed.xyz https://vembed.net https://vembed.org https://fsapi.xyz",
  "connect-src 'self' https://image.tmdb.org https://*.supabase.co wss://*.supabase.co data: blob:",
  "worker-src 'self'",
  "media-src 'self' blob: https:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

const nextConfig: NextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // Vercel handles output optimization automatically
  async headers() {
    return [
      // Security headers on ALL responses
      {
        source: '/(.*)',
        headers: securityHeaders,
      },
      // ── PWA icon files: explicit Content-Type + no-cache ──
      // iOS Safari aggressively caches icons and NEVER re-fetches.
      // Using no-cache ensures iOS always re-validates with the server.
      // New sv-* filenames also help because iOS has never cached them.
      {
        source: '/sv-icon-:size(\\d+).png',
        headers: [
          { key: 'Content-Type', value: 'image/png' },
          { key: 'Cache-Control', value: 'public, max-age=300' },
        ],
      },
      {
        source: '/sv-maskable-:size(\\d+).png',
        headers: [
          { key: 'Content-Type', value: 'image/png' },
          { key: 'Cache-Control', value: 'public, max-age=300' },
        ],
      },
      {
        source: '/sv-touch-:size(\\d+).png',
        headers: [
          { key: 'Content-Type', value: 'image/png' },
          { key: 'Cache-Control', value: 'public, max-age=300' },
        ],
      },
      {
        source: '/sv-favicon.png',
        headers: [
          { key: 'Content-Type', value: 'image/png' },
          { key: 'Cache-Control', value: 'public, max-age=300' },
        ],
      },
      // Old filenames — still serve correctly for any cached requests
      {
        source: '/icon-:size(\\d+).png',
        headers: [
          { key: 'Content-Type', value: 'image/png' },
          { key: 'Cache-Control', value: 'public, max-age=300' },
        ],
      },
      {
        source: '/icon-maskable-:size(\\d+).png',
        headers: [
          { key: 'Content-Type', value: 'image/png' },
          { key: 'Cache-Control', value: 'public, max-age=300' },
        ],
      },
      {
        source: '/apple-touch-icon.png',
        headers: [
          { key: 'Content-Type', value: 'image/png' },
          { key: 'Cache-Control', value: 'public, max-age=300' },
        ],
      },
      {
        source: '/apple-touch-icon-:size(\\d+).png',
        headers: [
          { key: 'Content-Type', value: 'image/png' },
          { key: 'Cache-Control', value: 'public, max-age=300' },
        ],
      },
      {
        source: '/favicon-32.png',
        headers: [
          { key: 'Content-Type', value: 'image/png' },
          { key: 'Cache-Control', value: 'public, max-age=300' },
        ],
      },
      // ── Manifest: must serve as application/json with proper CORS ──
      {
        source: '/manifest.json',
        headers: [
          { key: 'Content-Type', value: 'application/manifest+json' },
          { key: 'Cache-Control', value: 'public, max-age=300' },
        ],
      },
      // ── Service worker: no cache, must always revalidate ──
      {
        source: '/sw.js',
        headers: [
          { key: 'Content-Type', value: 'application/javascript' },
          { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
        ],
      },
      // CSP on page responses only — exclude API, static assets, and public files
      {
        source: '/:path((?!api|_next/static|_next/image|sw\\.js|manifest\\.json|offline\\.html|robots\\.txt|favicon\\.ico|icon-|sv-|apple-touch-icon|placeholder-poster).*)',
        headers: [
          { key: 'Content-Security-Policy', value: CONTENT_SECURITY_POLICY },
        ],
      },
    ];
  },
};

export default nextConfig;
