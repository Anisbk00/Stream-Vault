import { NextRequest } from 'next/server';
import { jsonResponse, errorResponse, getCorsHeaders, tmdbFetch, CACHE } from '@/lib/tmdb';
import { rateLimit, rateLimitResponse, getClientIp, RATE_LIMITS } from '@/lib/rate-limit';
import type { StreamSource } from '@/types/streaming';

export const dynamic = 'force-dynamic';

// ─── Provider Config ──────────────────────────────────────────────────────────

/** VidAPI embed domains — ad-heavy but reliable, no Cloudflare protection */
const VIDAPI_EMBED_DOMAINS = [
  'vidapi.ru',
  'vaplayer.ru',
] as const;

/** VidSrc.me active domains — embed fallback */
const VIDSRC_ME_DOMAINS = [
  'vidsrcme.ru',
  'vidsrcme.su',
  'vsrc.su',
] as const;

/** Premium embed providers — high quality, less ads, multi-server */
const VIDSRC_PREMIUM_DOMAINS = [
  'vidsrc.fyi',
  'vidsrc.ru',
] as const;

/** VidLink / VidFast — high-performance embed providers */
const VIDLINK_DOMAINS = [
  'vidlink.pro',
  'vidfast.pro',
] as const;

/** VidSrc.cc v2 — 1080p with autoplay, uses IMDB IDs */
const VIDSRC_CC_DOMAINS = [
  'vidsrc.cc',
] as const;

/** Vaplayer streamdata API — returns direct HLS m3u8 URLs */
const STREAM_DATA_API = 'https://streamdata.vaplayer.ru/api.php';

/** FilmU embed — uses IMDB IDs, supports movies & TV shows */
const FILMU_EMBED_BASE = 'https://embed.filmu.in';
const FILMU_API_KEY = process.env.FILMU_API_KEY || '';

// ─── Response Types ───────────────────────────────────────────────────────────

interface SourceResponse {
  embedUrl: string;
  /** Quality hint for the primary embed URL (e.g. "1080p") */
  quality: string;
  fallbackUrls: string[];
  sources: StreamSource[];
  /** How many embed providers were checked/available */
  providersChecked: number;
  /** Provider that returned each source for UI display */
  providerMap?: Record<string, string>;
  /** IMDB ID for this content (used for subtitle lookup) */
  imdbId?: string | null;
}

// ─── URL Builders ─────────────────────────────────────────────────────────────

function buildVidApiEmbedUrl(
  domain: string,
  type: 'movie' | 'tv',
  id: string,
  season: string,
  episode: string,
): string {
  if (type === 'movie') {
    return `https://${domain}/embed/movie/${id}`;
  }
  return `https://${domain}/embed/tv/${id}/${season}/${episode}`;
}

function buildVidSrcMeEmbedUrl(
  domain: string,
  type: 'movie' | 'tv',
  id: string,
  season: string,
  episode: string,
): string {
  if (type === 'movie') {
    return `https://${domain}/embed/movie/${id}`;
  }
  return `https://${domain}/embed/tv/${id}/${season}/${episode}`;
}

function buildVidLinkEmbedUrl(
  domain: string,
  type: 'movie' | 'tv',
  id: string,
  season: string,
  episode: string,
): string {
  if (type === 'movie') {
    return `https://${domain}/movie/${id}?autoPlay=true`;
  }
  return `https://${domain}/tv/${id}/${season}/${episode}?autoPlay=true`;
}

function buildVidSrcCcEmbedUrl(
  domain: string,
  type: 'movie' | 'tv',
  id: string,
  season: string,
  episode: string,
): string {
  if (type === 'movie') {
    return `https://${domain}/v2/embed/movie/${id}?autoPlay=true`;
  }
  return `https://${domain}/v2/embed/tv/${id}/${season}/${episode}?autoPlay=true`;
}


function withQualityHint(url: string, quality = '1080p'): string {
  return `${url}#quality=${quality}`;
}

/** Build embed URL using IMDB ID format (last-resort fallback for providers that support it) */
function buildImdbEmbedUrl(
  domain: string,
  type: 'movie' | 'tv',
  imdbId: string,
  season: string,
  episode: string,
): string {
  if (type === 'movie') {
    return `https://${domain}/embed/movie/${imdbId}`;
  }
  return `https://${domain}/embed/tv/${imdbId}/${season}/${episode}`;
}

function buildFilmuEmbedUrl(
  type: 'movie' | 'tv',
  imdbId: string,
  season: string,
  episode: string,
): string {
  if (type === 'movie') {
    return `${FILMU_EMBED_BASE}/movie/${imdbId}?apikey=${FILMU_API_KEY}`;
  }
  return `${FILMU_EMBED_BASE}/tv/${imdbId}/${season}/${episode}?apikey=${FILMU_API_KEY}`;
}

// ─── TMDB IMDB ID Lookup ─────────────────────────────────────────────────────

/** Fetch the IMDB ID for a TMDB movie/show — used for last-resort embed URLs */
async function fetchImdbId(tmdbId: string, type: 'movie' | 'tv'): Promise<string | null> {
  try {
    const path = type === 'movie'
      ? `/movie/${tmdbId}/external_ids`
      : `/tv/${tmdbId}/external_ids`;
    const data = await tmdbFetch<{ imdb_id?: string }>(path);
    return data?.imdb_id || null;
  } catch {
    return null;
  }
}

// ─── Vaplayer Stream Data ────────────────────────────────────────────────────

async function fetchVaplayerSources(
  id: string,
  type: 'movie' | 'tv',
  season: string,
  episode: string,
): Promise<StreamSource[]> {
  const sources: StreamSource[] = [];
  const params = new URLSearchParams();
  params.set('tmdb', id);
  params.set('type', type);
  if (type === 'tv') {
    params.set('season', season);
    params.set('episode', episode);
  }

  try {
    const response = await fetch(`${STREAM_DATA_API}?${params.toString()}`, {
      headers: {
        Accept: 'application/json, text/plain, */*',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Referer: 'https://brightpathsignals.com/',
      },
      signal: AbortSignal.timeout(8000), // Reduced from 15s — if it doesn't respond quickly, it's not going to
    });

    if (!response.ok) return sources;

    const rawText = await response.text();
    let data: ReturnType<typeof JSON.parse>;
    try {
      data = JSON.parse(rawText);
    } catch {
      return sources;
    }

    if (
      (data?.status_code === 200 || data?.status_code === '200') &&
      data?.data?.stream_urls &&
      Array.isArray(data.data.stream_urls)
    ) {
      const seen = new Set<string>();
      for (const url of data.data.stream_urls) {
        if (typeof url !== 'string' || !url || seen.has(url)) continue;
        seen.add(url);
        const isJustHd = url.includes('justhd.tv');
        sources.push({
          url,
          quality: isJustHd ? '1080p' : 'auto',
          type: 'hls',
          provider: 'vidapi',
        });
      }
    }
  } catch {
    // Vaplayer fetch failed
  }

  return sources;
}

// ─── Main GET Handler ────────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  const ip = getClientIp(request);
  const rl = rateLimit(ip, RATE_LIMITS.source);
  if (!rl.allowed) return rateLimitResponse(rl, RATE_LIMITS.source);

  try {
    const searchParams = request.nextUrl.searchParams;
    const id = searchParams.get('id');
    const type = searchParams.get('type') || 'movie';
    const season = searchParams.get('season') || '1';
    const episode = searchParams.get('episode') || '1';

    if (!id) {
      return errorResponse('Missing required "id" query parameter', 400);
    }

    const validTypes = ['movie', 'tv'];
    if (!validTypes.includes(type)) {
      return errorResponse(
        `Invalid type "${type}". Must be one of: ${validTypes.join(', ')}`,
        400,
      );
    }

    const mediaType = type as 'movie' | 'tv';

    // Build ALL embed URLs (ordered by user preference)
    // Client cycles through fallbacks automatically if primary fails to load.
    // No server-side HEAD checks — 403 from Cloudflare doesn't mean dead in iframe.
    const allEmbedUrls = [
      // ── Tier 1: Best video quality ────────────────────────────
      // VidSrc.fyi / VidSrc.ru (higher quality 1080p streams)
      ...VIDSRC_PREMIUM_DOMAINS.map((domain) =>
        buildVidApiEmbedUrl(domain, mediaType, id, season, episode)
      ),
      // VidLink / VidFast (biggest & fastest, premium quality)
      ...VIDLINK_DOMAINS.map((domain) =>
        buildVidLinkEmbedUrl(domain, mediaType, id, season, episode)
      ),

      // ── Tier 2: Reliable playback — VidAPI ────────────────────
      // VidAPI domains — reliable, no Cloudflare, sends PLAYER_EVENT
      // Popup ads are blocked by client-side window.open override
      ...VIDAPI_EMBED_DOMAINS.map((domain) =>
        withQualityHint(buildVidApiEmbedUrl(domain, mediaType, id, season, episode))
      ),

      // ── Tier 3: Good fallbacks ──────────────────────────────
      // 2Embed (good coverage for movies not found on Tier 1-2)
      withQualityHint(
        mediaType === 'movie'
          ? `https://www.2embed.cc/embed/${id}`
          : `https://www.2embed.cc/embedtv/${id}&s=${season}&e=${episode}`
      ),

      // ── Tier 4: Lower priority ──────────────────────────────
      // VidSrc.me domains
      ...VIDSRC_ME_DOMAINS.map((domain) =>
        withQualityHint(buildVidSrcMeEmbedUrl(domain, mediaType, id, season, episode))
      ),
      // Embed.su (DNS unreliable from some networks, keep as fallback)
      buildVidApiEmbedUrl('embed.su', mediaType, id, season, episode),

      // ── Tier 5: Last resort — Cloudflare protected, often blocked ──
      // VidSrc.cc v2 — behind Cloudflare JS challenge, rarely works in iframe
      ...VIDSRC_CC_DOMAINS.map((domain) =>
        buildVidSrcCcEmbedUrl(domain, mediaType, id, season, episode)
      ),
      // VidSrc.to (Cloudflare protected)
      withQualityHint(
        mediaType === 'movie'
          ? `https://vidsrc.to/embed/movie/${id}`
          : `https://vidsrc.to/embed/tv/${id}/${season}/${episode}`
      ),
    ];

    const embedUrl = allEmbedUrls[0];
    const fallbackUrls = allEmbedUrls.slice(1);

    // Fetch direct HLS sources + IMDB ID concurrently (non-blocking)
    const [vaplayerSources, imdbId] = await Promise.allSettled([
      fetchVaplayerSources(id, mediaType, season, episode),
      fetchImdbId(id, mediaType),
    ]);

    // IMDB ID based providers — add after TMDB ID providers
    // These use IMDB IDs (tt1234567) which some providers prefer
    if (imdbId.status === 'fulfilled' && imdbId.value) {
      const imdbFallbacks = [
        // FilmU (IMDB-based, no Cloudflare, ad-free with API key) — skip if key not configured
        ...(FILMU_API_KEY
          ? [withQualityHint(buildFilmuEmbedUrl(mediaType, imdbId.value!, season, episode))]
          : []),
        // VidAPI with IMDB ID
        ...VIDAPI_EMBED_DOMAINS.map((domain) =>
          withQualityHint(buildImdbEmbedUrl(domain, mediaType, imdbId.value!, season, episode))
        ),
        // VidSrc.to with IMDB ID
        withQualityHint(
          mediaType === 'movie'
            ? `https://vidsrc.to/embed/movie/${imdbId.value}`
            : `https://vidsrc.to/embed/tv/${imdbId.value}/${season}/${episode}`
        ),
      ];
      fallbackUrls.push(...imdbFallbacks);
    }

    const sources: StreamSource[] = [];
    const providerMap: Record<string, string> = {};

    if (vaplayerSources.status === 'fulfilled') {
      sources.push(...vaplayerSources.value);
      for (const s of vaplayerSources.value) {
        if (s.url) providerMap[s.url] = 'vidapi';
      }
    }

    // Deduplicate sources by URL
    const seenUrls = new Set<string>();
    const dedupedSources = sources.filter((s) => {
      if (seenUrls.has(s.url)) return false;
      seenUrls.add(s.url);
      return true;
    });

    const totalProviders = allEmbedUrls.length + (imdbId.status === 'fulfilled' && imdbId.value ? 4 : 0);

    const response: SourceResponse = {
      embedUrl,
      quality: '1080p',
      fallbackUrls,
      sources: dedupedSources,
      providersChecked: totalProviders,
      providerMap,
      imdbId: imdbId.status === 'fulfilled' ? imdbId.value ?? null : null,
    };

    return jsonResponse(response, 200, CACHE.content);
  } catch (error) {
    return errorResponse(
      error instanceof Error ? error.message : 'Failed to fetch stream sources',
    );
  }
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: getCorsHeaders(),
  });
}
