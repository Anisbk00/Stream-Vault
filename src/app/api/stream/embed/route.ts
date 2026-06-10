import { NextRequest } from 'next/server';
import { rateLimit, rateLimitResponse, getClientIp, RATE_LIMITS } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

/**
 * Ad-free embed proxy.
 *
 * Fetches the embed page HTML from the provider, strips ad elements,
 * injects comprehensive ad-blocking CSS, and serves a clean page
 * through our own domain so the iframe never touches the original
 * ad-infested URL directly.
 *
 * Usage: GET /api/stream/embed?url=<encoded_embed_url>
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ─── Ad-blocking CSS ──────────────────────────────────────────────────────────
// Comprehensive selectors that cover all major embed player ad networks.
// Injected as a <style> tag at the top of the page.

const AD_BLOCK_CSS = `
/* ── Generic ad containers ──────────────────────────────────── */
[class*="ad-"], [class*="ad_"], [class*="ads-"], [class*="ads_"],
[class*="adv-"], [class*="adv_"], [class*="advert"], [class*="sponsor"],
[class*="promo"], [class*="banner"], [class*="popup"], [class*="popunder"],
[class*="overlay-ad"], [class*="video-ad"], [class*="pre-roll"],
[class*="mid-roll"], [class*="post-roll"], [class*="commercial"],
[id*="ad-"], [id*="ad_"], [id*="ads-"], [id*="ads_"],
[id*="adv-"], [id*="adv_"], [id*="advert"], [id*="sponsor"],
[id*="promo"], [id*="banner"], [id*="popup"], [id*="popunder"],
[id*="overlay-ad"], [id*="video-ad"], [id*="pre-roll"],
[data-ad], [data-ads], [data-ad-slot], [data-ad-unit],
[data-ad-client], [data-ad-channel], [data-ad-position],

/* ── Iframe-based ads ──────────────────────────────────────── */
iframe[src*="doubleclick.net"], iframe[src*="googlesyndication"],
iframe[src*="googleadservices"], iframe[src*="adnxs"],
iframe[src*="amazon-adsystem"], iframe[src*="facebook.net"],
iframe[src*="taboola"], iframe[src*="outbrain"],
iframe[src*="popads"], iframe[src*="popunder"],
iframe[src*="juicyads"], iframe[src*="exoclick"],
iframe[src*="trafficjunky"], iframe[src*="adsterra"],
iframe[src*="hilltopads"], iframe[src*="clickadu"],
iframe[src*="propellerads"], iframe[src*="revcontent"],
iframe[src*="mgid"], iframe[src*="monetag"],
iframe[src*="propeller"], iframe[src*="admaven"],

/* ── Known ad network elements ─────────────────────────────── */
[class*="google-ad"], [class*="gpt-ad"], [id*="google_ads"],
[class*="AdSlot"], [class*="AdContainer"], [class*="AdWrapper"],
[class*="ad-container"], [class*="ad-wrapper"], [class*="ad-slot"],
[class*="ad-unit"], [class*="ad-banner"], [class*="ad-card"],
.ins.adsbygoogle, .adsbygoogle, #adsbygoogle,

/* ── Pop-up / pop-under / redirect elements ────────────────── */
a[target="_blank"][style*="position:fixed"],
a[target="_blank"][style*="position:absolute"],
a[href*="click"], a[href*="redirect"], a[href*="go.php"],
a[href*="tracking"], a[href*="affiliate"],
[onclick*="window.open"], [onclick*="location.href"],
[onclick*="document.location"], [onclick*="redirect"],

/* ── Floating / fixed-position ad containers ───────────────── */
div[style*="position: fixed"][style*="z-index"]:not(.jw-),
div[style*="position:fixed"][style*="z-index"]:not(.jw-),
div[style*="position: fixed"][style*="bottom"]:not(.jw-),
div[style*="position:fixed"][style*="bottom"]:not(.jw-),

/* ── Sticky ads ────────────────────────────────────────────── */
[class*="sticky-ad"], [class*="sticky_ad"],
[class*="ad-sticky"], [id*="sticky-ad"], [id*="sticky_ad"],

/* ── Notification / push prompts ───────────────────────────── */
[class*="notification-prompt"], [class*="push-prompt"],
[class*="subscribe-popup"], [class*="newsletter-popup"],
[class*="cookie-notice"], [class*="cookie-banner"],
[class*="consent-banner"], [class*="gdpr-"], [id*="consent"],

/* ── Interstitial / full-page ads ──────────────────────────── */
[class*="interstitial"], [class*="fullpage-ad"],
[class*="full-page-ad"], [class*="page-ad"],

/* ── Specific embed player ad patterns ─────────────────────── */
.jw-flag_ads, .jw-ad-CTA, .jw-ad-label, .jw-ad-skip,
.jw-related-shelf-item-ad, .jw-ad-dismissible,
.video-ad-overlay, .ad-overlay, .ad-overlay-container,
.vast-overlay, .vast-skip-button,

/* ── VidSrc / VidAPI specific ad selectors ─────────────────── */
#player-container > div:not([id]):not([class*="jw"]):not([class*="video"]),
.player-container > div:not([id]):not([class*="jw"]):not([class*="video"]),
div[class*="visible"][style*="z-index: 999"],
div[class*="visible"][style*="z-index:999"],
div[style*="z-index: 2147483647"],
div[style*="z-index:2147483647"],

/* ── Anti-adblock detection bypass ─────────────────────────── */
[class*="adblock"], [class*="ad-block"], [class*="adblocker"],
[id*="adblock"], [id*="ad-block"], [id*="adblocker"],
[class*="notice-adblock"], [id*="notice-adblock"],
[class*="disable-adblock"], [id*="disable-adblock"],

/* ── Force hide ────────────────────────────────────────────── */
{ display: none !important; visibility: hidden !important; height: 0 !important; max-height: 0 !important; overflow: hidden !important; opacity: 0 !important; pointer-events: none !important; }
`;

// ─── Ad-blocking JS ───────────────────────────────────────────────────────────
// Intercepts popup windows and removes ad elements that slip past CSS.

const AD_BLOCK_JS = `
<script>
(function() {
  'use strict';

  // ── Block popup windows ───────────────────────────────────────
  window.open = function() { return null; };

  // ── Prevent top-level navigation from ads ─────────────────────
  try {
    var origAssign = window.location.assign.bind(window.location);
    var origReplace = window.location.replace.bind(window.location);
    var currentHost = window.location.hostname;

    // Only allow navigation within the same embed
    window.location.assign = function(url) {
      if (typeof url === 'string' && (url.includes(currentHost) || url.includes('.m3u8'))) {
        return origAssign(url);
      }
    };
    window.location.replace = function(url) {
      if (typeof url === 'string' && (url.includes(currentHost) || url.includes('.m3u8'))) {
        return origReplace(url);
      }
    };
  } catch(e) {}

  // ── Intercept click events on ad links ────────────────────────
  document.addEventListener('click', function(e) {
    var target = e.target;
    while (target && target !== document) {
      if (target.tagName === 'A' && target.target === '_blank') {
        e.preventDefault();
        e.stopPropagation();
        return false;
      }
      target = target.parentElement;
    }
  }, true);

  // ── MutationObserver to remove dynamic ad elements ────────────
  var observer = new MutationObserver(function(mutations) {
    for (var i = 0; i < mutations.length; i++) {
      var added = mutations[i].addedNodes;
      for (var j = 0; j < added.length; j++) {
        var node = added[j];
        if (node.nodeType !== 1) continue;

        // Remove iframes that aren't the video player
        if (node.tagName === 'IFRAME') {
          var src = node.src || '';
          if (!src.includes('m3u8') && !src.includes('jwplayer') && !src.includes('player')) {
            node.remove();
          }
        }

        // Remove script tags from ad domains
        if (node.tagName === 'SCRIPT') {
          var src = node.src || '';
          var adDomains = ['doubleclick', 'googlesyndication', 'googleadservices',
            'adnxs', 'amazon-adsystem', 'taboola', 'outbrain', 'popads',
            'juicyads', 'exoclick', 'trafficjunky', 'adsterra', 'hilltopads',
            'clickadu', 'propellerads', 'revcontent', 'mgid', 'monetag',
            'admaven', 'creativecdn', 'adserver', 'realsrv', 'magsrv'];
          if (adDomains.some(function(d) { return src.toLowerCase().includes(d); })) {
            node.remove();
          }
        }
      }
    }
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  });

  // ── Periodic cleanup for stubborn ads ─────────────────────────
  setInterval(function() {
    // Remove fixed-position non-player elements
    document.querySelectorAll('div[style*="position: fixed"], div[style*="position:fixed"]').forEach(function(el) {
      if (!el.classList.contains('jw-') && !el.id.startsWith('jw-') && !el.querySelector('video')) {
        el.style.display = 'none';
        el.style.height = '0';
        el.style.overflow = 'hidden';
      }
    });
  }, 1000);
})();
</script>
`;

// ─── HTML Cleaning Functions ──────────────────────────────────────────────────

/** Remove <script> tags that load from ad domains */
function stripAdScripts(html: string): string {
  const adDomains = [
    'doubleclick.net', 'googlesyndication.com', 'googleadservices.com',
    'adnxs.com', 'amazon-adsystem.com', 'taboola.com', 'outbrain.com',
    'popads.net', 'juicyads.com', 'exoclick.com', 'trafficjunky.net',
    'adsterra.com', 'hilltopads.com', 'clickadu.com', 'propellerads.com',
    'revcontent.com', 'mgid.com', 'monetag.com', 'admaven.com',
    'creativecdn.com', 'adserver.com', 'pushnotifications.com',
    'go.strm.io', 'realsrv.com', 'a.magsrv.com',
    'dsb4f7y9p3c6.cloudfront.net', 'clickiocdn.com', 'waip1.tv',
  ];

  // Remove script tags with src from ad domains
  let cleaned = html.replace(
    /<script[^>]+src=["']([^"']+)["'][^>]*>\s*<\/script>/gi,
    (match, src) => {
      const lower = src.toLowerCase();
      if (adDomains.some(d => lower.includes(d))) return '';
      return match;
    }
  );

  // Remove inline scripts that contain ad-related code
  cleaned = cleaned.replace(
    /<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/gi,
    (match, content) => {
      const lower = content.toLowerCase();
      const adKeywords = ['popunder', 'clickadu', 'propeller', 'adblock',
        'adblocker', 'notification.permission', 'pushmanager', 'serviceworker',
        'window.open', 'document.write', 'location.replace',
        'createObjectURL', 'adpushup', 'vli_platform', 'cmp.quantcast',
        '_taboola', '_outbrain', 'admiral', 'finditup', 'aniview',
        'admiral', 'ftrai', 'anti-adblock'];
      if (adKeywords.some(k => lower.includes(k))) return '';
      return match;
    }
  );

  return cleaned;
}

/** Remove ad iframes */
function stripAdIframes(html: string): string {
  const adDomains = [
    'doubleclick.net', 'googlesyndication.com', 'googleadservices.com',
    'adnxs.com', 'amazon-adsystem.com', 'taboola.com', 'outbrain.com',
    'popads.net', 'juicyads.com', 'exoclick.com', 'trafficjunky.net',
    'adsterra.com', 'hilltopads.com', 'clickadu.com', 'propellerads.com',
    'realsrv.com', 'a.magsrv.com',
  ];

  return html.replace(
    /<iframe[^>]+src=["']([^"']+)["'][^>]*>[\s\S]*?<\/iframe>/gi,
    (match, src) => {
      const lower = src.toLowerCase();
      if (adDomains.some(d => lower.includes(d))) return '';
      return match;
    }
  );
}

/** Inject our ad-block CSS and JS into the HTML */
function injectAdBlockers(html: string): string {
  const cssTag = `<style>${AD_BLOCK_CSS}</style>`;
  const jsTag = AD_BLOCK_JS;

  // Inject CSS right after <head> or at the start
  if (html.includes('<head>')) {
    html = html.replace('<head>', `<head>${cssTag}${jsTag}`);
  } else if (html.includes('<HEAD>')) {
    html = html.replace('<HEAD>', `<HEAD>${cssTag}${jsTag}`);
  } else {
    html = cssTag + jsTag + html;
  }

  return html;
}

// ─── Allowed embed domains ────────────────────────────────────────────────────

const ALLOWED_HOSTS = [
  // Only working providers
  'vidapi.ru', 'vaplayer.ru',
  'embed.su', '2embed.cc', 'www.2embed.cc',
  'vidsrc.link',
];

// ─── Main Handler ─────────────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  // Rate limit
  const ip = getClientIp(request);
  const rl = rateLimit(ip, RATE_LIMITS.embed);
  if (!rl.allowed) return rateLimitResponse(rl, RATE_LIMITS.embed);

  try {
    const url = request.nextUrl.searchParams.get('url');
    if (!url) {
      return new Response('Missing "url" query parameter', { status: 400 });
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      return new Response('Invalid URL', { status: 400 });
    }

    if (!['https:', 'http:'].includes(parsedUrl.protocol)) {
      return new Response('Only HTTP(S) URLs are allowed', { status: 400 });
    }

    // Only allow known embed domains
    if (!ALLOWED_HOSTS.some(host => parsedUrl.hostname === host || parsedUrl.hostname.endsWith('.' + host))) {
      return new Response('Domain not allowed', { status: 403 });
    }

    // Fetch the embed page
    const referer = `${parsedUrl.origin}/`;
    const response = await fetch(url, {
      headers: {
        Accept: 'text/html,application/xhtml+xml,*/*',
        'User-Agent': UA,
        Referer: referer,
      },
      signal: AbortSignal.timeout(15000),
      redirect: 'follow',
    });

    if (!response.ok) {
      // Cloudflare challenge or other server-side block — redirect the iframe
      // to the direct URL so the browser can handle Cloudflare naturally.
      // Server-side proxy cannot bypass Cloudflare's JS challenge.
      return Response.redirect(url, 302);
    }

    let html = await response.text();

    // Check for Cloudflare challenge — redirect to direct URL
    // The challenge JS tries to load /cdn-cgi/ paths from our domain, which don't exist.
    if (html.includes('challenge-platform') || html.includes('Just a moment')) {
      return Response.redirect(url, 302);
    }

    // ── Inject <base> tag so relative URLs resolve to the original domain ──
    const baseTag = `<base href="${parsedUrl.origin}/">`;
    if (html.includes('<head>')) {
      html = html.replace('<head>', `<head>${baseTag}`);
    } else if (html.includes('<HEAD>')) {
      html = html.replace('<HEAD>', `<HEAD>${baseTag}`);
    } else {
      html = baseTag + html;
    }

    // ── Apply ad stripping ───────────────────────────────────
    html = stripAdScripts(html);
    html = stripAdIframes(html);
    html = injectAdBlockers(html);

    return new Response(html, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=600',
        'Content-Security-Policy': "default-src * 'unsafe-inline' 'unsafe-eval' data: blob: https: http:; media-src * https: blob: data: http:; frame-src * https:; child-src * https:;",
        'X-Frame-Options': 'ALLOWALL',
      },
    });
  } catch (error) {
    // Timeout or network error — redirect iframe to direct URL as fallback
    const url = request.nextUrl.searchParams.get('url');
    if (url && error instanceof Error && (error.name === 'TimeoutError' || error.message.includes('abort') || error.message.includes('timeout'))) {
      return Response.redirect(url, 302);
    }
    const message = error instanceof Error ? error.message : 'Embed proxy failed';
    return new Response(message, { status: 502 });
  }
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
