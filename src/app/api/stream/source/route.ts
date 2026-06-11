import { NextRequest } from 'next/server';
import { jsonResponse, errorResponse, getCorsHeaders, tmdbFetch, CACHE } from '@/lib/tmdb';
import { rateLimit, rateLimitResponse, getClientIp, RATE_LIMITS } from '@/lib/rate-limit';
import type { StreamSource } from '@/types/streaming';

export const dynamic = 'force-dynamic';

// ─── Provider Config ──────────────────────────────────────────────────────────
// Only providers that actually work reliably. No Cloudflare-blocked domains.

/** VidAPI — primary provider, no Cloudflare protection */
const VIDAPI_DOMAIN = 'vidapi.ru';

/** Vaplayer streamdata API — returns direct HLS m3u8 URLs */
const STREAM_DATA_API = 'https://streamdata.vaplayer.ru/api.php';

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
}

// ─── URL Builders ─────────────────────────────────────────────────────────────

function withQualityHint(url: string, quality = '1080p'): string {
  return `${url}#quality=${quality}`;
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
      signal: AbortSignal.timeout(8000),
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

    // Only working providers — no dead domains, no Cloudflare-blocked pages
    const allEmbedUrls = [
      // VidAPI (primary — verified working, no Cloudflare)
      withQualityHint(
        mediaType === 'movie'
          ? `https://${VIDAPI_DOMAIN}/embed/movie/${id}`
          : `https://${VIDAPI_DOMAIN}/embed/tv/${id}/${season}/${episode}`
      ),
    ];

    const embedUrl = allEmbedUrls[0];
    const fallbackUrls = allEmbedUrls.slice(1);

    // Fetch direct HLS sources (non-blocking)
    const vaplayerSources = await Promise.allSettled([
      fetchVaplayerSources(id, mediaType, season, episode),
    ]);

    const sources: StreamSource[] = [];
    const providerMap: Record<string, string> = {};

    if (vaplayerSources[0].status === 'fulfilled') {
      sources.push(...vaplayerSources[0].value);
      for (const s of vaplayerSources[0].value) {
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

    const response: SourceResponse = {
      embedUrl,
      quality: '1080p',
      fallbackUrls,
      sources: dedupedSources,
      providersChecked: allEmbedUrls.length,
      providerMap,
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
