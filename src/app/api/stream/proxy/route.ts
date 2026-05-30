import { NextRequest } from 'next/server';
import { rateLimit, rateLimitResponse, getClientIp, RATE_LIMITS } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

/**
 * Proxy endpoint for fetching remote video segments/files.
 * Used by the HLS downloader to bypass CORS restrictions.
 *
 * On 403 (CDN hotlink protection), automatically retries with
 * alternate Referer headers matching known streaming embed domains.
 *
 * Handles gzip-compressed text responses (m3u8 manifests) from CDNs
 * that ignore Accept-Encoding: identity.
 *
 * SECURITY: Domain allowlist enforced — only known CDN/hosting domains
 * can be proxied. Private/internal IPs are blocked (SSRF mitigation).
 *
 * Usage: GET /api/stream/proxy?url=<encoded_url>[&referer=<hint>]
 */

/** Referer origins to try when CDN returns 403 (most likely first) */
const CDN_REFERER_FALLBACKS = [
  // Active CDNs that actually serve content — tried first for speed
  'https://justhd.tv/',
  'https://tmstrd.justhd.tv/',
  'https://vidapi.ru/',
  'https://vaplayer.ru/',
  'https://brightpathsignals.com/',
  'https://conversionfocusedstudio.site/',
  'https://streamdata.vaplayer.ru/',
  // VidSrc family
  'https://vidsrc.to/',
  'https://vidsrcme.ru/',
  'https://vidsrcme.su/',
  'https://vidsrc-embed.ru/',
  'https://vidsrc-embed.su/',
  'https://vsrc.su/',
  // Other embed providers
  'https://embed.su/',
  'https://2embed.cc/',
  'https://playembed.site/',
  'https://multiembed.mov/',
];

/**
 * CDN domains that require an embed-page origin (vidapi.ru / vaplayer.ru)
 * to validate requests. For these domains, the matching-domain referer
 * (e.g., Origin: https://conversionfocusedstudio.site) is NEVER correct —
 * the CDN expects the embed page's origin, not its own. We prioritize
 * vidapi.ru / vaplayer.ru origins for these domains.
 *
 * This does NOT fix IP-based blocking (Vercel datacenter IPs may still be
 * blocked), but it ensures the correct Origin header is sent first.
 */
const EMBED_ORIGIN_REQUIRED_DOMAINS = new Set([
  'conversionfocusedstudio.site',
  'remoteconsultinggroup.site',
  'brightpathsignals.com',
]);

/** Embed page origins that CDNs accept as valid request origins */
const EMBED_ORIGINS = [
  'https://vidapi.ru/',
  'https://vaplayer.ru/',
];

/**
 * Domain allowlist for the proxy.
 * Only URLs whose hostname ends with one of these are allowed through.
 * This prevents the proxy from being used as an open SSRF vector to
 * arbitrary external services.
 */
const ALLOWED_DOMAINS: ReadonlySet<string> = new Set([
  // TMDB image CDN
  'image.tmdb.org',
  // VidAPI / Vaplayer CDN domains
  'vidapi.ru',
  'vaplayer.ru',
  'streamdata.vaplayer.ru',
  'brightpathsignals.com',
  // VidSrc domains
  'vidsrc.to',
  'vidsrc.pm',
  'vidsrc.me',
  'vidsrc.cc',
  'vidsrcme.ru',
  'vidsrcme.su',
  'vidsrc-embed.ru',
  'vidsrc-embed.su',
  'vidsrc-me.ru',
  'vidsrc-me.su',
  'vsrc.su',
  // Embed providers
  'embed.su',
  '2embed.cc',
  'www.2embed.cc',
  'multiembed.mov',
  'playembed.site',
  // Common video CDN patterns (m3u8 segments from these CDNs)
  'vidstream.to',
  'vidsrc.xyz',
  'moviesapi.club',
  'multiembed.mov',
  //justhd.tv CDN
  'justhd.tv',
  // VidAPI/Vaplayer HLS CDN (rotated domains)
  'remoteconsultinggroup.site',
  'conversionfocusedstudio.site',
  // Known HLS segment CDNs used by embed providers
  'lightning-fast-streaming.com',
  'trailers.to',
  'rabbitstream.net',
  'playtube.ws',
  'vidsrc.icu',
  'vidsrc.cc',
  'superstream.one',
  'tosstream.cc',
]);

/** Check if a hostname matches any allowed domain (including subdomains) */
function isDomainAllowed(hostname: string): boolean {
  // Exact match or subdomain match
  if (ALLOWED_DOMAINS.has(hostname)) return true;
  for (const allowed of ALLOWED_DOMAINS) {
    if (hostname.endsWith('.' + allowed)) return true;
  }
  return false;
}

/** Max 403 retries before giving up — must be high enough to try all referers.
 *  With ~20 referers + no-referer, 3 was far too low — the correct referer
 *  might be 4th+ in the list, causing false 403s that block high-quality sources. */
const MAX_403_RETRIES = 12;

/** Max retries for upstream 503/502 (server overloaded) — brief pause then retry */
const MAX_UPSTREAM_RETRIES = 2;
const UPSTREAM_RETRY_DELAY_MS = 1000;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** Content types that should be buffered as text (m3u8 manifests, JSON).
 *  NOTE: text/html is intentionally excluded — HLS CDNs serve binary video
 *  segments with .html extension and text/html content type. Buffering them
 *  as text would corrupt the binary data. */
const TEXT_CONTENT_TYPES = [
  'application/vnd.apple.mpegurl',
  'application/x-mpegurl',
  'application/json',
];

function isTextContent(contentType: string): boolean {
  return TEXT_CONTENT_TYPES.some((t) => contentType.includes(t));
}

/** Validate URL and return parsed URL, or a 400 Response on failure */
function validateUrl(url: string | null): { parsed: URL } | { error: Response } {
  if (!url) {
    return { error: new Response('Missing "url" query parameter', { status: 400 }) };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { error: new Response('Invalid URL', { status: 400 }) };
  }
  if (!['https:', 'http:'].includes(parsed.protocol)) {
    return { error: new Response('Only HTTP(S) URLs are allowed', { status: 400 }) };
  }

  // SSRF protection — block private/internal IPs
  const hostname = parsed.hostname;
  if (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname.startsWith('10.') ||
    hostname.startsWith('192.168.') ||
    (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(hostname)) ||
    hostname === '0.0.0.0'
  ) {
    return { error: new Response('Private/internal URLs are not allowed', { status: 400 }) };
  }

  // Domain allowlist — only proxy to known CDN/embed domains
  if (!isDomainAllowed(hostname)) {
    return { error: new Response('Domain not allowed', { status: 403 }) };
  }

  return { parsed };
}

export async function GET(request: NextRequest) {
  // Rate limit
  const ip = getClientIp(request);
  const rlResult = rateLimit(ip, RATE_LIMITS.proxy);
  if (!rlResult.allowed) {
    return rateLimitResponse(rlResult, RATE_LIMITS.proxy);
  }

  try {
    const validation = validateUrl(request.nextUrl.searchParams.get('url'));
    if ('error' in validation) return validation.error;
    const { parsed: parsedUrl } = validation;

    // Build ordered list of referers to try.
    // Strategy depends on the target domain:
    // - For EMBED_ORIGIN_REQUIRED_DOMAINS (e.g., conversionfocusedstudio.site),
    //   the CDN validates the Origin header and only allows embed page origins
    //   (vidapi.ru, vaplayer.ru). The matching-domain referer is NEVER correct.
    // - For other CDNs, matching-domain referers are most likely to succeed.
    const targetHost = parsedUrl.hostname;
    const callerReferer = request.nextUrl.searchParams.get('referer');
    const referers: string[] = [];

    const needsEmbedOrigin = EMBED_ORIGIN_REQUIRED_DOMAINS.has(targetHost)
      || Array.from(EMBED_ORIGIN_REQUIRED_DOMAINS).some(d => targetHost.endsWith('.' + d));

    if (needsEmbedOrigin) {
      // For embed-origin-required CDNs, try embed origins FIRST (before matching-domain)
      // because the CDN rejects requests with its own origin (Origin: https://conversionfocusedstudio.site)
      // and only accepts embed page origins (Origin: https://vidapi.ru).

      // 1. Caller's explicit referer (full embed URL — most specific)
      if (callerReferer) {
        referers.push(callerReferer);
      }

      // 2. Embed page origins (vidapi.ru, vaplayer.ru)
      for (const eo of EMBED_ORIGINS) {
        if (!referers.includes(eo)) referers.push(eo);
      }

      // 3. Matching-domain referers (unlikely to work but worth trying)
      const matchingReferers = CDN_REFERER_FALLBACKS.filter((r) => {
        try {
          const refHost = new URL(r).hostname;
          return targetHost === refHost
            || targetHost.endsWith('.' + refHost)
            || refHost.endsWith('.' + targetHost);
        } catch { return false; }
      });
      for (const r of matchingReferers) {
        if (!referers.includes(r)) referers.push(r);
      }

      // 4. Remaining fallbacks
      for (const r of CDN_REFERER_FALLBACKS) {
        if (!referers.includes(r)) referers.push(r);
      }
    } else {
      // Standard strategy: matching-domain referers first
      const matchingReferers = CDN_REFERER_FALLBACKS.filter((r) => {
        try {
          const refHost = new URL(r).hostname;
          return targetHost === refHost
            || targetHost.endsWith('.' + refHost)
            || refHost.endsWith('.' + targetHost);
        } catch { return false; }
      });
      if (matchingReferers.length > 0) {
        referers.push(...matchingReferers);
      }

      // 2. Caller's explicit referer (if not already included)
      if (callerReferer && !referers.includes(callerReferer) && !CDN_REFERER_FALLBACKS.includes(callerReferer)) {
        referers.push(callerReferer);
      }

      // 3. Remaining fallbacks (skip already-added matching ones)
      for (const r of CDN_REFERER_FALLBACKS) {
        if (!referers.includes(r)) referers.push(r);
      }
    }

    // No-referer attempt as last resort
    referers.push(null as unknown as string);

    let retry403Count = 0;

    for (const referer of referers) {
      const isNoReferer = referer === null;
      let origin: string | undefined;
      if (!isNoReferer) {
        try {
          origin = new URL(referer).origin;
        } catch {
          origin = undefined;
        }
      }

      const headers: Record<string, string> = {
        'User-Agent': UA,
        Accept: '*/*',
        'Accept-Encoding': 'identity',
        // Browser-like Sec-Fetch headers — some CDNs check these
        // to distinguish real browser requests from bots/proxies
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'cross-site',
      };
      if (!isNoReferer) {
        if (origin) headers['Origin'] = origin;
        headers['Referer'] = referer;
      }

      const response = await fetch(parsedUrl.href, {
        headers,
        signal: AbortSignal.timeout(20000),
      });

      // Success — stream through
      if (response.ok) {
        const contentType = response.headers.get('Content-Type') || 'application/octet-stream';
        const contentLength = response.headers.get('Content-Length');

        // For text-based content (m3u8, json, etc.), read as text so the
        // runtime handles any decompression automatically.
        if (isTextContent(contentType)) {
          const text = await response.text();

          const respHeaders = new Headers();
          respHeaders.set('Content-Type', contentType);
          respHeaders.set('Content-Length', String(new TextEncoder().encode(text).length));
          respHeaders.set('Access-Control-Allow-Origin', '*');
          respHeaders.set('Cache-Control', 'public, max-age=3600');
          respHeaders.set('X-RateLimit-Remaining', String(rlResult.remaining));

          return new Response(text, { headers: respHeaders });
        }

        // Binary content — stream through directly (video segments, etc.)
        const respHeaders = new Headers();
        respHeaders.set('Content-Type', contentType);
        if (contentLength) {
          respHeaders.set('Content-Length', contentLength);
        }
        respHeaders.set('Access-Control-Allow-Origin', '*');
        respHeaders.set('Cache-Control', 'public, max-age=3600');
        respHeaders.set('X-RateLimit-Remaining', String(rlResult.remaining));

        return new Response(response.body, { headers: respHeaders });
      }

      // CDN 403 — hotlink protection. Cancel body and try next referer.
      if (response.status === 403 && retry403Count < MAX_403_RETRIES) {
        response.body?.cancel();
        retry403Count++;
        continue;
      }

      // Upstream 503/502 — server overloaded. Retry with delay.
      if ((response.status === 503 || response.status === 502) && retry403Count === 0) {
        response.body?.cancel();
        // Try with each remaining referer + retry with delay
        for (let retry = 1; retry <= MAX_UPSTREAM_RETRIES; retry++) {
          await new Promise(r => setTimeout(r, UPSTREAM_RETRY_DELAY_MS * retry));
          const retryResponse = await fetch(parsedUrl.href, {
            headers,
            signal: AbortSignal.timeout(20000),
          });
          if (retryResponse.ok) {
            const contentType = retryResponse.headers.get('Content-Type') || 'application/octet-stream';
            const contentLength = retryResponse.headers.get('Content-Length');
            if (isTextContent(contentType)) {
              const text = await retryResponse.text();
              const respHeaders = new Headers();
              respHeaders.set('Content-Type', contentType);
              respHeaders.set('Content-Length', String(new TextEncoder().encode(text).length));
              respHeaders.set('Access-Control-Allow-Origin', '*');
              respHeaders.set('Cache-Control', 'public, max-age=3600');
              respHeaders.set('X-RateLimit-Remaining', String(rlResult.remaining));
              respHeaders.set('X-Upstream-Retries', String(retry));
              return new Response(text, { headers: respHeaders });
            }
            const respHeaders = new Headers();
            respHeaders.set('Content-Type', contentType);
            if (contentLength) respHeaders.set('Content-Length', contentLength);
            respHeaders.set('Access-Control-Allow-Origin', '*');
            respHeaders.set('Cache-Control', 'public, max-age=3600');
            respHeaders.set('X-RateLimit-Remaining', String(rlResult.remaining));
            respHeaders.set('X-Upstream-Retries', String(retry));
            return new Response(retryResponse.body, { headers: respHeaders });
          }
          // If retry gets 403, break out and let the referer loop handle it
          if (retryResponse.status === 403) break;
          retryResponse.body?.cancel();
        }
        // All retries failed, return the last error
        return new Response(
          `Upstream returned ${response.status}: ${response.statusText}`,
          { status: response.status },
        );
      }

      // Any other error — return immediately
      return new Response(
        `Upstream returned ${response.status}: ${response.statusText}`,
        { status: response.status },
      );
    }

    // All referers exhausted — CDN access denied
    return new Response('CDN access denied after referer fallback', { status: 403 });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Proxy request failed';
    return new Response(message, { status: 502 });
  }
}

/** HEAD — returns headers only (used by HLS downloader to estimate segment sizes) */
export async function HEAD(request: NextRequest) {
  // Rate limit
  const ip = getClientIp(request);
  const rlResult = rateLimit(ip, RATE_LIMITS.proxy);
  if (!rlResult.allowed) {
    return rateLimitResponse(rlResult, RATE_LIMITS.proxy);
  }

  try {
    const validation = validateUrl(request.nextUrl.searchParams.get('url'));
    if ('error' in validation) return validation.error;
    const { parsed: parsedUrl } = validation;

    const callerReferer = request.nextUrl.searchParams.get('referer');
    const targetHost = parsedUrl.hostname;
    const referers: string[] = [];

    const needsEmbedOrigin = EMBED_ORIGIN_REQUIRED_DOMAINS.has(targetHost)
      || Array.from(EMBED_ORIGIN_REQUIRED_DOMAINS).some(d => targetHost.endsWith('.' + d));

    if (needsEmbedOrigin) {
      // Same embed-origin-first strategy as GET handler
      if (callerReferer) referers.push(callerReferer);
      for (const eo of EMBED_ORIGINS) {
        if (!referers.includes(eo)) referers.push(eo);
      }
      const matchingReferers = CDN_REFERER_FALLBACKS.filter((r) => {
        try {
          const refHost = new URL(r).hostname;
          return targetHost === refHost
            || targetHost.endsWith('.' + refHost)
            || refHost.endsWith('.' + targetHost);
        } catch { return false; }
      });
      for (const r of matchingReferers) {
        if (!referers.includes(r)) referers.push(r);
      }
      for (const r of CDN_REFERER_FALLBACKS) {
        if (!referers.includes(r)) referers.push(r);
      }
    } else {
      // Standard strategy: matching-domain referers first
      const matchingReferers = CDN_REFERER_FALLBACKS.filter((r) => {
        try {
          const refHost = new URL(r).hostname;
          return targetHost === refHost
            || targetHost.endsWith('.' + refHost)
            || refHost.endsWith('.' + targetHost);
        } catch {
          return false;
        }
      });
      if (matchingReferers.length > 0) referers.push(...matchingReferers);
      if (callerReferer && !referers.includes(callerReferer) && !CDN_REFERER_FALLBACKS.includes(callerReferer)) {
        referers.push(callerReferer);
      }
      for (const r of CDN_REFERER_FALLBACKS) {
        if (!referers.includes(r)) referers.push(r);
      }
    }
    referers.push(null as unknown as string);

    let retry403Count = 0;

    for (const referer of referers) {
      const isNoReferer = referer === null;
      let origin: string | undefined;
      if (!isNoReferer) {
        try {
          origin = new URL(referer).origin;
        } catch {
          origin = undefined;
        }
      }

      const headers: Record<string, string> = {
        'User-Agent': UA,
        Accept: '*/*',
        'Accept-Encoding': 'identity',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'cross-site',
      };
      if (!isNoReferer) {
        if (origin) headers['Origin'] = origin;
        headers['Referer'] = referer;
      }

      const response = await fetch(parsedUrl.href, {
        method: 'HEAD',
        headers,
        signal: AbortSignal.timeout(8000),
      });

      if (response.ok) {
        const contentType = response.headers.get('Content-Type') || 'application/octet-stream';
        const contentLength = response.headers.get('Content-Length');

        const respHeaders = new Headers();
        respHeaders.set('Content-Type', contentType);
        if (contentLength) {
          respHeaders.set('Content-Length', contentLength);
        }
        respHeaders.set('Access-Control-Allow-Origin', '*');
        respHeaders.set('Cache-Control', 'public, max-age=3600');
        respHeaders.set('X-RateLimit-Remaining', String(rlResult.remaining));

        return new Response(null, { headers: respHeaders, status: 200 });
      }

      if (response.status === 403 && retry403Count < MAX_403_RETRIES) {
        retry403Count++;
        continue;
      }

      return new Response(
        `Upstream returned ${response.status}: ${response.statusText}`,
        { status: response.status },
      );
    }

    return new Response('CDN access denied after referer fallback', { status: 403 });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Proxy request failed';
    return new Response(message, { status: 502 });
  }
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    },
  });
}
