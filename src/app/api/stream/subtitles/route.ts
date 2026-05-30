import { NextRequest } from 'next/server';
import { jsonResponse, errorResponse, tmdbFetch, CACHE } from '@/lib/tmdb';
import { rateLimit, rateLimitResponse, getClientIp, RATE_LIMITS } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

/**
 * Subtitle fetch API route.
 *
 * Fetches subtitles for movies/TV shows using OpenSubtitles API.
 * Requires OPENSUBTITLES_API_KEY environment variable.
 * If the key is not configured, returns empty subtitles gracefully.
 *
 * Query params:
 *   - id: TMDB ID (required)
 *   - type: 'movie' | 'tv' (required)
 *   - season: season number (for TV)
 *   - episode: episode number (for TV)
 *   - languages: comma-separated language codes (e.g. 'en,fr,ar')
 */

const OPENSUBTITLES_API_KEY = process.env.OPENSUBTITLES_API_KEY || '';
const OPENSUBTITLES_API_BASE = 'https://api.opensubtitles.com/api/v1';

interface OpenSubtitlesSearchResult {
  id: string;
  attributes: {
    subtitle_id: string;
    language: string;
    download_count: number;
    fps: number;
    from_trusted: boolean;
    foreign_parts_only: boolean;
    upload_date: string;
    files: Array<{ file_id: number; file_name: string; cd_number: number }>;
    moviehash_match?: boolean;
    release_name?: string;
  };
}

interface OpenSubtitlesSearchResponse {
  data: OpenSubtitlesSearchResult[];
}

interface OpenSubtitlesDownloadResponse {
  link: string;
  file_name: string;
  remaining: number;
}

/** Map ISO 639-1 language codes to OpenSubtitles language names */
const LANG_CODE_TO_OS: Record<string, string> = {
  en: 'en',
  es: 'es',
  fr: 'fr',
  de: 'de',
  it: 'it',
  pt: 'pt',
  ja: 'ja',
  ko: 'ko',
  zh: 'zh',
  ar: 'ar',
  hi: 'hi',
  ru: 'ru',
  tr: 'tr',
  pl: 'pl',
  nl: 'nl',
  sv: 'sv',
  th: 'th',
  uk: 'uk',
  'pt-br': 'pt-BR',
  'zh-cn': 'zh-CN',
  'zh-tw': 'zh-TW',
};

/** Convert SRT subtitle content to WebVTT format */
function srtToVtt(srt: string): string {
  let vtt = 'WEBVTT\n\n';

  // Normalize line endings
  const normalized = srt.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // Split into subtitle blocks (separated by blank lines)
  const blocks = normalized.split(/\n\n+/);

  for (const block of blocks) {
    const lines = block.trim().split('\n');
    if (lines.length < 2) continue;

    // Find the timestamp line (contains -->)
    let tsIndex = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('-->')) {
        tsIndex = i;
        break;
      }
    }

    if (tsIndex === -1) continue;

    // Skip the sequence number line if present (SRT format: number\n timestamp\n text)
    const timestampLine = lines[tsIndex];
    const textLines = lines.slice(tsIndex + 1);

    // Convert SRT timestamp format: 00:01:23,456 → WebVTT: 00:01:23.456
    const vttTimestamp = timestampLine.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');

    // Only include if there's actual text content
    if (textLines.length > 0 && textLines.some(l => l.trim().length > 0)) {
      vtt += `${vttTimestamp}\n`;
      vtt += textLines.join('\n');
      vtt += '\n\n';
    }
  }

  return vtt;
}

/** Detect if content is SRT format */
function isSrtFormat(content: string): boolean {
  // SRT files typically start with a number followed by a timestamp line
  const trimmed = content.trim();
  if (trimmed.startsWith('WEBVTT')) return false;
  return /\d{2}:\d{2}:\d{2}[,\.]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[,\.]\d{3}/.test(trimmed);
}

export async function GET(request: NextRequest) {
  const ip = getClientIp(request);
  const rl = rateLimit(ip, RATE_LIMITS.source);
  if (!rl.allowed) return rateLimitResponse(rl, RATE_LIMITS.source);

  // If no OpenSubtitles API key configured, return empty gracefully
  if (!OPENSUBTITLES_API_KEY) {
    return jsonResponse({
      subtitles: {},
      tracks: [],
      message: 'Subtitle API not configured (OPENSUBTITLES_API_KEY missing)',
    }, 200, CACHE.content);
  }

  try {
    const searchParams = request.nextUrl.searchParams;
    const id = searchParams.get('id');
    const type = searchParams.get('type') || 'movie';
    const season = searchParams.get('season');
    const episode = searchParams.get('episode');
    const languages = searchParams.get('languages') || '';

    if (!id) {
      return errorResponse('Missing required "id" query parameter', 400);
    }

    const validTypes = ['movie', 'tv'];
    if (!validTypes.includes(type)) {
      return errorResponse(`Invalid type "${type}". Must be one of: ${validTypes.join(', ')}`, 400);
    }

    const mediaType = type as 'movie' | 'tv';

    // Step 1: Resolve IMDB ID from TMDB
    const externalIdsPath = mediaType === 'movie'
      ? `/movie/${id}/external_ids`
      : `/tv/${id}/external_ids`;

    let imdbId: string | null = null;
    try {
      const extData = await tmdbFetch<{ imdb_id?: string }>(externalIdsPath);
      imdbId = extData?.imdb_id || null;
    } catch {
      // TMDB lookup failed — can't search subtitles without IMDB ID
      return jsonResponse({
        subtitles: {},
        tracks: [],
        message: 'Failed to resolve IMDB ID from TMDB',
      }, 200, CACHE.content);
    }

    if (!imdbId) {
      return jsonResponse({
        subtitles: {},
        tracks: [],
        message: 'No IMDB ID found for this content',
      }, 200, CACHE.content);
    }

    // Parse requested languages
    const requestedLangs = languages
      .split(',')
      .map(l => l.trim())
      .filter(Boolean);

    // If no languages specified, default to English
    const targetLangs = requestedLangs.length > 0 ? requestedLangs : ['en'];

    // Step 2: Search OpenSubtitles for each language
    const subtitles: Record<string, string> = {};
    const tracks: Array<{ language: string; name: string; isDefault: boolean }> = [];

    for (const lang of targetLangs) {
      const osLang = LANG_CODE_TO_OS[lang] || lang;

      try {
        // Search for subtitles
        const searchParams = new URLSearchParams({
          imDbId: imdbId.replace('tt', ''), // OpenSubtitles expects numeric IMDB ID
          languages: osLang,
          type: mediaType === 'tv' ? 'episode' : 'movie',
        });

        if (mediaType === 'tv' && season) {
          searchParams.set('season_number', season);
        }
        if (mediaType === 'tv' && episode) {
          searchParams.set('episode_number', episode);
        }

        const searchResp = await fetch(`${OPENSUBTITLES_API_BASE}/subtitles?${searchParams.toString()}`, {
          headers: {
            'Api-Key': OPENSUBTITLES_API_KEY,
            'User-Agent': 'StreamVault',
            'Content-Type': 'application/json',
          },
          signal: AbortSignal.timeout(8000),
        });

        if (!searchResp.ok) continue;

        const searchData: OpenSubtitlesSearchResponse = await searchResp.json();
        if (!searchData.data || searchData.data.length === 0) continue;

        // Pick the best subtitle: prefer high download count, trusted sources, and non-foreign-parts-only
        const sorted = [...searchData.data].sort((a, b) => {
          // Prefer non-foreign-parts-only (full subtitles > forced narration only)
          if (a.attributes.foreign_parts_only !== b.attributes.foreign_parts_only) {
            return a.attributes.foreign_parts_only ? 1 : -1;
          }
          // Prefer trusted sources
          if (a.attributes.from_trusted !== b.attributes.from_trusted) {
            return a.attributes.from_trusted ? -1 : 1;
          }
          // Prefer higher download count
          return b.attributes.download_count - a.attributes.download_count;
        });

        const bestMatch = sorted[0];
        if (!bestMatch.attributes.files || bestMatch.attributes.files.length === 0) continue;

        const fileId = bestMatch.attributes.files[0].file_id;

        // Step 3: Request download link
        const downloadResp = await fetch(`${OPENSUBTITLES_API_BASE}/download`, {
          method: 'POST',
          headers: {
            'Api-Key': OPENSUBTITLES_API_KEY,
            'User-Agent': 'StreamVault',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ file_id: fileId }),
          signal: AbortSignal.timeout(8000),
        });

        if (!downloadResp.ok) continue;

        const downloadData: OpenSubtitlesDownloadResponse = await downloadResp.json();
        if (!downloadData.link) continue;

        // Step 4: Download subtitle content
        const contentResp = await fetch(downloadData.link, {
          signal: AbortSignal.timeout(8000),
        });

        if (!contentResp.ok) continue;

        let content = await contentResp.text();

        // Step 5: Convert SRT to VTT if necessary
        if (isSrtFormat(content)) {
          content = srtToVtt(content);
        }

        // Validate it's actual subtitle content (not an error page)
        if (content.length < 20) continue;
        if (content.includes('<!DOCTYPE') || content.includes('<html')) continue;

        subtitles[lang] = content;
        tracks.push({
          language: lang,
          name: bestMatch.attributes.release_name || lang,
          isDefault: lang === targetLangs[0],
        });

        console.log(
          `[SV Subtitles] ✓ Downloaded subtitle: lang=${lang}, ` +
          `release='${bestMatch.attributes.release_name || 'unknown'}', ` +
          `size=${(content.length / 1024).toFixed(1)}KB`
        );
      } catch (err) {
        // Subtitle fetch failed for this language — non-critical
        console.warn(
          `[SV Subtitles] Failed to fetch subtitle for lang=${lang}: ` +
          `${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    return jsonResponse({
      subtitles: Object.keys(subtitles).length > 0 ? subtitles : undefined,
      tracks: tracks.length > 0 ? tracks : undefined,
    }, 200, CACHE.content);
  } catch (error) {
    console.error(
      `[SV Subtitles] Error: ${error instanceof Error ? error.message : String(error)}`
    );
    // Return empty response instead of error — subtitles are non-critical
    return jsonResponse({
      subtitles: {},
      tracks: [],
    }, 200, CACHE.content);
  }
}

export async function OPTIONS() {
  return new Response(null, { status: 204 });
}
