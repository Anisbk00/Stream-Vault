import { NextRequest, NextResponse } from 'next/server';
import { getCorsHeaders } from '@/lib/tmdb';

export const dynamic = 'force-dynamic';

/**
 * Subtitle Search API
 *
 * Searches for subtitles using external providers (SubDL, OpenSubtitles).
 * API keys are stored server-side for security.
 *
 * Query params:
 * - imdb_id: IMDB ID (with or without 'tt' prefix)
 * - tmdb_id: TMDB ID (alternative to imdb_id — will resolve to IMDB ID)
 * - type: 'movie' or 'tv'
 * - languages: comma-separated language codes (e.g. 'en,es,fr')
 * - season: season number (for TV shows)
 * - episode: episode number (for TV shows)
 */

const SUBDL_API_KEY = process.env.SUBDL_API_KEY || '';
const OPENSUBTITLES_API_KEY = process.env.OPENSUBTITLES_API_KEY || '';
const TMDB_API_KEY = process.env.TMDB_API_KEY || '';

// Log missing API keys at startup to help diagnose subtitle download failures
if (!TMDB_API_KEY) console.warn('[SV Subtitles] TMDB_API_KEY not configured — cannot resolve TMDB→IMDB IDs for subtitle search');
if (!SUBDL_API_KEY) console.warn('[SV Subtitles] SUBDL_API_KEY not configured — SubDL subtitle search disabled');
if (!OPENSUBTITLES_API_KEY) console.warn('[SV Subtitles] OPENSUBTITLES_API_KEY not configured — OpenSubtitles search disabled');

async function getImdbIdFromTmdb(tmdbId: string, type: 'movie' | 'tv'): Promise<string | null> {
  if (!TMDB_API_KEY) return null;
  try {
    const endpoint = type === 'tv'
      ? `https://api.themoviedb.org/3/tv/${tmdbId}/external_ids?api_key=${TMDB_API_KEY}`
      : `https://api.themoviedb.org/3/movie/${tmdbId}/external_ids?api_key=${TMDB_API_KEY}`;
    const resp = await fetch(endpoint, { signal: AbortSignal.timeout(8000) });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.imdb_id || null;
  } catch {
    return null;
  }
}

interface SubdlSubtitle {
  lang: string;
  url: string;
  name?: string;
}

async function searchSubdl(
  imdbId: string,
  languages: string[],
  season?: number,
  episode?: number,
): Promise<Array<{ lang: string; url: string; name: string }>> {
  if (!SUBDL_API_KEY) return [];

  const results: Array<{ lang: string; url: string; name: string }> = [];

  for (const lang of languages) {
    try {
      const params = new URLSearchParams({
        api_key: SUBDL_API_KEY,
        film_imdb: imdbId.replace('tt', ''),
        languages: lang,
      });
      if (season !== undefined) params.set('sd_season_number', String(season));
      if (episode !== undefined) params.set('sd_episode_number', String(episode));

      const resp = await fetch(
        `https://api.subdl.com/api/v1/subtitles?${params}`,
        { signal: AbortSignal.timeout(10000) },
      );

      if (!resp.ok) continue;

      const data = await resp.json();
      const subs = data?.subtitles as SubdlSubtitle[] | undefined;
      if (!subs || subs.length === 0) continue;

      const sub = subs[0];
      if (sub?.url) {
        const downloadUrl = sub.url.startsWith('http')
          ? sub.url
          : `https://api.subdl.com${sub.url}`;
        results.push({
          lang,
          url: downloadUrl,
          name: sub.name || lang,
        });
      }
    } catch {
      // Skip failed language
    }
  }

  return results;
}

interface OsSubtitleData {
  attributes?: {
    files?: Array<{ file_id: number; file_name?: string }>;
    language?: string;
  };
}

async function searchOpenSubtitles(
  imdbId: string,
  languages: string[],
  season?: number,
  episode?: number,
): Promise<Array<{ lang: string; fileId: number; name: string }>> {
  if (!OPENSUBTITLES_API_KEY) return [];

  const results: Array<{ lang: string; fileId: number; name: string }> = [];

  for (const lang of languages) {
    try {
      const params: Record<string, string> = {
        imdb_id: imdbId,
        languages: lang,
      };
      if (season !== undefined) params.season_number = String(season);
      if (episode !== undefined) params.episode_number = String(episode);

      const resp = await fetch(
        `https://api.opensubtitles.com/api/v1/subtitles?${new URLSearchParams(params)}`,
        {
          headers: {
            'Api-Key': OPENSUBTITLES_API_KEY,
            'User-Agent': 'StreamVault v1.0',
          },
          signal: AbortSignal.timeout(10000),
        },
      );

      if (!resp.ok) continue;

      const data = await resp.json();
      const subData: OsSubtitleData | undefined = data?.data?.[0];
      if (!subData?.attributes?.files?.[0]) continue;

      const fileId = subData.attributes.files[0].file_id;
      results.push({
        lang,
        fileId,
        name: subData.attributes.files[0].file_name || lang,
      });
    } catch {
      // Skip failed language
    }
  }

  return results;
}

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;

  const imdbId = searchParams.get('imdb_id');
  const tmdbId = searchParams.get('tmdb_id');
  const type = (searchParams.get('type') || 'movie') as 'movie' | 'tv';
  const languagesParam = searchParams.get('languages') || 'en';
  const season = searchParams.get('season') ? parseInt(searchParams.get('season')!) : undefined;
  const episode = searchParams.get('episode') ? parseInt(searchParams.get('episode')!) : undefined;

  const languages = languagesParam.split(',').filter(Boolean);

  if (!imdbId && !tmdbId) {
    return NextResponse.json(
      { error: 'imdb_id or tmdb_id is required' },
      { status: 400, headers: getCorsHeaders() },
    );
  }

  // Resolve IMDB ID
  let resolvedImdbId = imdbId;
  if (!resolvedImdbId && tmdbId) {
    resolvedImdbId = await getImdbIdFromTmdb(tmdbId, type);
  }

  if (!resolvedImdbId) {
    const missingKeys: string[] = [];
    if (!TMDB_API_KEY) missingKeys.push('TMDB_API_KEY');
    return NextResponse.json(
      {
        error: 'Could not resolve IMDB ID',
        detail: missingKeys.length > 0
          ? `Missing API keys: ${missingKeys.join(', ')}. Configure these in .env to enable subtitle search.`
          : 'TMDB API returned no IMDB ID for this content',
        subtitles: [],
      },
      { status: 404, headers: getCorsHeaders() },
    );
  }

  // Search both providers in parallel
  const [subdlResults, osResults] = await Promise.all([
    searchSubdl(resolvedImdbId, languages, season, episode),
    searchOpenSubtitles(resolvedImdbId, languages, season, episode),
  ]);

  // Merge results (SubDL first, then OpenSubtitles for missing languages)
  const foundLangs = new Set(subdlResults.map(r => r.lang));
  const osMissing = osResults.filter(r => !foundLangs.has(r.lang));

  const subtitles = [
    ...subdlResults.map(r => ({ ...r, provider: 'subdl' })),
    ...osMissing.map(r => ({ ...r, provider: 'opensubtitles' })),
  ];

  return NextResponse.json(
    {
      imdb_id: resolvedImdbId,
      subtitles,
    },
    { headers: getCorsHeaders() },
  );
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    },
  });
}
