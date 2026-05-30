import { NextRequest } from 'next/server';
import { jsonResponse } from '@/lib/tmdb';

export const dynamic = 'force-dynamic';

/**
 * Diagnostic endpoint — tests subtitle API chain end-to-end.
 * Visit /api/stream/subtitles-test?tmdbId=550 to verify:
 * 1. Whether OPENSUBTITLES_API_KEY is configured
 * 2. Whether TMDB_API_KEY is configured
 * 3. Sample subtitle search results (both imdb_id and tmdb_id)
 *
 * REMOVE after debugging is complete.
 */
export async function GET(request: NextRequest) {
  const opApiKey = process.env.OPENSUBTITLES_API_KEY || '';
  const tmdbKey = process.env.TMDB_API_KEY || '';
  const tmdbToken = process.env.TMDB_READ_ACCESS_TOKEN || '';

  const tmdbId = request.nextUrl.searchParams.get('tmdbId') || '550';

  const envStatus = {
    OPENSUBTITLES_API_KEY: opApiKey
      ? `configured (${opApiKey.length} chars, starts with "${opApiKey[0]}")`
      : 'NOT CONFIGURED',
    TMDB_API_KEY: tmdbKey
      ? `configured (${tmdbKey.length} chars)`
      : 'NOT CONFIGURED',
    TMDB_READ_ACCESS_TOKEN: tmdbToken
      ? `configured (${tmdbToken.length} chars)`
      : 'NOT CONFIGURED',
  };

  // Fetch IMDB ID from TMDB
  let imdbId: string | null = null;
  if (tmdbKey || tmdbToken) {
    try {
      const url = new URL(`https://api.themoviedb.org/3/movie/${tmdbId}/external_ids`);
      if (tmdbKey) url.searchParams.set('api_key', tmdbKey);
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (tmdbToken) headers['Authorization'] = `Bearer ${tmdbToken}`;
      const res = await fetch(url.toString(), { headers, signal: AbortSignal.timeout(10000) });
      if (res.ok) {
        const data = await res.json();
        imdbId = data?.imdb_id || null;
      } else {
        imdbId = `TMDB API error: ${res.status} ${res.statusText}`;
      }
    } catch (err) {
      imdbId = `TMDB fetch failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // Search OpenSubtitles with imdb_id
  const imdbSearch: { count: number; error?: string; languages?: string[] } = { count: 0 };
  if (opApiKey && typeof imdbId === 'string' && imdbId.startsWith('tt')) {
    try {
      const numericId = parseInt(imdbId.replace('tt', ''));
      const res = await fetch(
        `https://api.opensubtitles.com/api/v1/subtitles?imdb_id=${numericId}`,
        {
          headers: {
            'Api-Key': opApiKey,
            'User-Agent': 'StreamVault v1.0',
            Accept: 'application/json',
          },
          signal: AbortSignal.timeout(10000),
        },
      );
      if (res.ok) {
        const data = await res.json();
        imdbSearch.count = data?.data?.length || 0;
        imdbSearch.languages = (data?.data || [])
          .slice(0, 5)
          .map((item: { attributes?: { language?: string } }) => item.attributes?.language);
      } else {
        imdbSearch.error = `HTTP ${res.status} ${res.statusText}`;
      }
    } catch (err) {
      imdbSearch.error = err instanceof Error ? err.message : String(err);
    }
  }

  // Search OpenSubtitles with tmdb_id (fallback)
  const tmdbSearch: { count: number; error?: string; languages?: string[] } = { count: 0 };
  if (opApiKey) {
    try {
      const res = await fetch(
        `https://api.opensubtitles.com/api/v1/subtitles?tmdb_id=${parseInt(tmdbId)}`,
        {
          headers: {
            'Api-Key': opApiKey,
            'User-Agent': 'StreamVault v1.0',
            Accept: 'application/json',
          },
          signal: AbortSignal.timeout(10000),
        },
      );
      if (res.ok) {
        const data = await res.json();
        tmdbSearch.count = data?.data?.length || 0;
        tmdbSearch.languages = (data?.data || [])
          .slice(0, 5)
          .map((item: { attributes?: { language?: string } }) => item.attributes?.language);
      } else {
        tmdbSearch.error = `HTTP ${res.status} ${res.statusText}`;
      }
    } catch (err) {
      tmdbSearch.error = err instanceof Error ? err.message : String(err);
    }
  }

  return jsonResponse({
    env: envStatus,
    tmdbId,
    imdbId,
    search_by_imdb_id: imdbSearch,
    search_by_tmdb_id: tmdbSearch,
  }, 200);
}
