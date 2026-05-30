import { NextRequest } from 'next/server';
import { jsonResponse, errorResponse, getCorsHeaders, tmdbFetch } from '@/lib/tmdb';
import { rateLimit, rateLimitResponse, getClientIp, RATE_LIMITS } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

const OPENSUBTITLES_API = 'https://api.opensubtitles.com/api/v1';
const OPENSUBTITLES_API_KEY = process.env.OPENSUBTITLES_API_KEY || '';
const OPENSUBTITLES_USER_AGENT = 'StreamVault v1.0';

// ─── IMDB ID Lookup ────────────────────────────────────────────────────────

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

// ─── OpenSubtitles: Search ──────────────────────────────────────────────────

async function searchSubtitles(
  imdbId: string,
  season?: number,
  episode?: number,
): Promise<{
  id: string;
  language: string;
  languageName: string;
  downloadCount: number;
  releaseName: string;
}[]> {
  if (!OPENSUBTITLES_API_KEY) return [];

  try {
    const params = new URLSearchParams();
    params.set('imdb_id', parseInt(imdbId.replace('tt', '')).toString());
    if (season !== undefined) params.set('season_number', season.toString());
    if (episode !== undefined) params.set('episode_number', episode.toString());

    const response = await fetch(
      `${OPENSUBTITLES_API}/subtitles?${params.toString()}`,
      {
        headers: {
          'Api-Key': OPENSUBTITLES_API_KEY,
          'User-Agent': OPENSUBTITLES_USER_AGENT,
          'Accept': 'application/json',
        },
        signal: AbortSignal.timeout(10000),
      },
    );

    if (!response.ok) return [];

    const data = await response.json();
    if (!data?.data || !Array.isArray(data.data)) return [];

    // Map and sort by download count (highest first)
    return data.data
      .filter((item: { attributes?: { feature_details?: { moviehash_match?: boolean }; url?: string }; file_id?: string }) =>
        item.file_id && item.attributes?.url
      )
      .map((item: { id: string; file_id: string; attributes: { language: string; language_name?: string; download_count: number; release: string; feature_details?: { moviehash_match?: boolean } } }) => ({
        id: String(item.file_id),
        language: item.attributes.language,
        languageName: item.attributes.language_name || item.attributes.language,
        downloadCount: item.attributes.download_count || 0,
        releaseName: item.attributes.release || '',
      }))
      .sort((a: { downloadCount: number }, b: { downloadCount: number }) => b.downloadCount - a.downloadCount);
  } catch {
    return [];
  }
}

// ─── OpenSubtitles: Download ──────────────────────────────────────────────

async function downloadSubtitle(fileId: string): Promise<string | null> {
  if (!OPENSUBTITLES_API_KEY) return null;

  try {
    // Step 1: Request download link
    const dlResponse = await fetch(`${OPENSUBTITLES_API}/download`, {
      method: 'POST',
      headers: {
        'Api-Key': OPENSUBTITLES_API_KEY,
        'User-Agent': OPENSUBTITLES_USER_AGENT,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({ file_id: fileId }),
      signal: AbortSignal.timeout(10000),
    });

    if (!dlResponse.ok) return null;

    const dlData = await dlResponse.json();
    if (!dlData?.link) return null;

    // Step 2: Fetch the actual subtitle file
    const fileResponse = await fetch(dlData.link, {
      headers: { 'User-Agent': OPENSUBTITLES_USER_AGENT },
      signal: AbortSignal.timeout(15000),
    });

    if (!fileResponse.ok) return null;

    return await fileResponse.text();
  } catch {
    return null;
  }
}

// ─── GET Handler ────────────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  const ip = getClientIp(request);
  const rl = rateLimit(ip, RATE_LIMITS.source);
  if (!rl.allowed) return rateLimitResponse(rl, RATE_LIMITS.source);

  try {
    const action = request.nextUrl.searchParams.get('action');
    const tmdbId = request.nextUrl.searchParams.get('tmdbId');

    if (!tmdbId) {
      return errorResponse('Missing "tmdbId" query parameter', 400);
    }

    const type = (request.nextUrl.searchParams.get('type') || 'movie') as 'movie' | 'tv';
    const season = request.nextUrl.searchParams.get('season')
      ? parseInt(request.nextUrl.searchParams.get('season')!, 10)
      : undefined;
    const episode = request.nextUrl.searchParams.get('episode')
      ? parseInt(request.nextUrl.searchParams.get('episode')!, 10)
      : undefined;

    if (type !== 'movie' && type !== 'tv') {
      return errorResponse('Invalid type — must be "movie" or "tv"', 400);
    }

    // ── Search action: return available subtitle tracks ──
    if (action === 'search') {
      if (!OPENSUBTITLES_API_KEY) {
        return jsonResponse({ tracks: [], error: 'OpenSubtitles API key not configured' }, 200);
      }

      const imdbId = await fetchImdbId(tmdbId, type);
      if (!imdbId) {
        return jsonResponse({ tracks: [], error: 'IMDB ID not found for this content' }, 200);
      }

      const tracks = await searchSubtitles(imdbId, season, episode);
      // Deduplicate by language (keep highest download count per language)
      const seen = new Map<string, (typeof tracks)[0]>();
      for (const track of tracks) {
        const existing = seen.get(track.language);
        if (!existing || track.downloadCount > existing.downloadCount) {
          seen.set(track.language, track);
        }
      }
      const dedupedTracks = Array.from(seen.values());
      return jsonResponse({ tracks: dedupedTracks, imdbId }, 200);
    }

    // ── Download action: return subtitle file content ──
    if (action === 'download') {
      const fileId = request.nextUrl.searchParams.get('fileId');
      if (!fileId) {
        return errorResponse('Missing "fileId" query parameter', 400);
      }

      if (!OPENSUBTITLES_API_KEY) {
        return errorResponse('OpenSubtitles API key not configured', 503);
      }

      const content = await downloadSubtitle(fileId);
      if (!content) {
        return errorResponse('Failed to download subtitle file', 502);
      }

      return new Response(content, {
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'public, max-age=86400', // 24h — subtitle files rarely change
          ...Object.fromEntries(getCorsHeaders().entries()),
        },
      });
    }

    return errorResponse('Missing or invalid "action" parameter — use "search" or "download"', 400);
  } catch (error) {
    return errorResponse(
      error instanceof Error ? error.message : 'Subtitle fetch failed',
    );
  }
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: getCorsHeaders(),
  });
}
