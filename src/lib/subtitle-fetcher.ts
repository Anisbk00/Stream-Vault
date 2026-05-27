/**
 * External Subtitle Fetcher
 *
 * When an HLS m3u8 manifest doesn't include #EXT-X-MEDIA TYPE=SUBTITLES
 * (which is common for free streaming CDNs), this module fetches subtitles
 * from external sources as a fallback.
 *
 * Uses the SubDL API (free, no API key required) and OpenSubtitles as backup.
 * Converts SRT subtitles to VTT format for web playback compatibility.
 */

import type { SubtitleTrackInfo } from './hls-downloader';

// ── SRT → VTT Converter ─────────────────────────────────────────────────────

/**
 * Convert SRT subtitle format to WebVTT format.
 * SRT uses commas in timestamps (00:00:00,000) while VTT uses periods (00:00:00.000).
 * Also strips SRT-specific formatting that VTT doesn't support.
 */
export function srtToVtt(srtContent: string): string {
  let vtt = 'WEBVTT\n\n';

  // Normalize line endings
  const normalized = srtContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // Split into blocks (separated by blank lines)
  const blocks = normalized.split(/\n\n+/);

  for (const block of blocks) {
    const lines = block.trim().split('\n');
    if (lines.length < 2) continue;

    // Find the timestamp line (contains -->)
    let timestampIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('-->')) {
        timestampIdx = i;
        break;
      }
    }

    if (timestampIdx === -1) continue;

    // Convert SRT timestamps to VTT format (comma → period)
    const timestampLine = lines[timestampIdx]
      .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');

    // Get subtitle text (everything after timestamp line)
    const textLines = lines.slice(timestampIdx + 1)
      .map(line => {
        // Strip SRT-specific formatting tags (<i>, <b>, <u>, <font>)
        return line
          .replace(/<font[^>]*>/gi, '')
          .replace(/<\/font>/gi, '')
          .replace(/<[^/!?][^>]*>/g, (match) => {
            // Keep basic VTT-supported tags
            if (/^<(b|i|u|ruby|rt|lang)/i.test(match)) return match;
            return '';
          });
      })
      .filter(Boolean);

    if (textLines.length === 0) continue;

    // Skip sequence number (SRT has it, VTT doesn't need it)
    vtt += timestampLine + '\n';
    vtt += textLines.join('\n') + '\n\n';
  }

  return vtt;
}

// ── TMDB External IDs ───────────────────────────────────────────────────────

interface TmdbExternalIds {
  imdb_id?: string;
}

/**
 * Fetch IMDB ID from TMDB API using the content's TMDB ID.
 * The IMDB ID is needed for most subtitle APIs.
 */
async function getImdbId(
  tmdbId: string | number,
  mediaType: 'movie' | 'tv',
): Promise<string | null> {
  const { TMDB_API_KEY } = await import('./tmdb');
  if (!TMDB_API_KEY) return null;

  try {
    const endpoint = mediaType === 'tv'
      ? `https://api.themoviedb.org/3/tv/${tmdbId}/external_ids`
      : `https://api.themoviedb.org/3/movie/${tmdbId}/external_ids`;

    const resp = await fetch(
      `${endpoint}?api_key=${TMDB_API_KEY}`,
      { signal: AbortSignal.timeout(8000) },
    );

    if (!resp.ok) return null;

    const data: TmdbExternalIds = await resp.json();
    return data.imdb_id || null;
  } catch {
    return null;
  }
}

// ── Server-side subtitle API ────────────────────────────────────────────────

/**
 * Fetch subtitles through our server-side API route.
 * This keeps API keys server-side and works from the client too.
 * Tries SubDL first, then OpenSubtitles for missing languages.
 */
async function fetchFromServerApi(
  imdbId: string,
  languages: string[],
  season?: number,
  episode?: number,
): Promise<Record<string, string>> {
  const subtitles: Record<string, string> = {};

  try {
    const params = new URLSearchParams({
      imdb_id: imdbId,
      languages: languages.join(','),
    });
    if (season !== undefined) params.set('season', String(season));
    if (episode !== undefined) params.set('episode', String(episode));

    const resp = await fetch(`/api/subtitles?${params}`, {
      signal: AbortSignal.timeout(15000),
    });

    if (!resp.ok) return subtitles;

    const data = await resp.json();
    const subs = data?.subtitles as Array<{ lang: string; url: string; provider: string }> | undefined;
    if (!subs || subs.length === 0) return subtitles;

    // Download each subtitle file
    for (const sub of subs) {
      try {
        let srtContent: string;

        if (sub.provider === 'opensubtitles') {
          // OpenSubtitles requires a download link request
          continue; // Handled differently — skip for now (needs file_id workflow)
        }

        // SubDL: direct download URL
        const subResp = await fetch(sub.url, {
          signal: AbortSignal.timeout(15000),
        });
        if (!subResp.ok) continue;

        srtContent = await subResp.text();
        if (!srtContent.includes('-->') || srtContent.length < 20) continue;

        const vttContent = srtToVtt(srtContent);
        if (vttContent.length > 20) {
          subtitles[sub.lang] = vttContent;
        }
      } catch {
        // Skip failed subtitle download
      }
    }
  } catch {
    // Server API failed — non-critical
  }

  return subtitles;
}

// ── SubDL API (direct client-side) ────────────────────────────────────────

/**
 * Search and download subtitles from SubDL API.
 * Requires SUBDL_API_KEY environment variable (free at subdl.com).
 * Supports IMDB ID search with season/episode for TV shows.
 *
 * Returns VTT content keyed by language code.
 */
async function fetchFromSubdl(
  imdbId: string,
  languages: string[],
  season?: number,
  episode?: number,
): Promise<Record<string, string>> {
  const subtitles: Record<string, string> = {};

  // SubDL now requires an API key — skip silently if not configured
  const apiKey = process.env.NEXT_PUBLIC_SUBDL_API_KEY || process.env.SUBDL_API_KEY;
  if (!apiKey) {
    console.log('[SV Subtitles] SubDL API key not configured — skipping SubDL');
    return subtitles;
  }

  for (const lang of languages) {
    try {
      const params = new URLSearchParams({
        api_key: apiKey,
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
      const subs = data?.subtitles as Array<{ lang: string; url: string; name?: string }> | undefined;
      if (!subs || subs.length === 0) continue;

      // Take the first matching subtitle for this language
      const sub = subs[0];
      if (!sub?.url) continue;

      // Download the subtitle file
      const downloadUrl = sub.url.startsWith('http')
        ? sub.url
        : `https://api.subdl.com${sub.url}`;

      const subResp = await fetch(downloadUrl, {
        signal: AbortSignal.timeout(15000),
      });

      if (!subResp.ok) continue;

      const srtContent = await subResp.text();

      // Validate it looks like an SRT file
      if (!srtContent.includes('-->') || srtContent.length < 20) continue;

      // Convert SRT to VTT
      const vttContent = srtToVtt(srtContent);
      if (vttContent.length > 20) {
        subtitles[lang] = vttContent;
      }
    } catch {
      // Subtitle fetch failed for this language — non-critical
    }
  }

  return subtitles;
}

// ── OpenSubtitles API ───────────────────────────────────────────────────────

/**
 * Search and download subtitles from OpenSubtitles.com API.
 * Requires OPENSUBTITLES_API_KEY env var. Free tier: 5 requests/day.
 * Used as fallback when SubDL doesn't have the subtitle.
 */
async function fetchFromOpenSubtitles(
  imdbId: string,
  languages: string[],
  season?: number,
  episode?: number,
): Promise<Record<string, string>> {
  const apiKey = process.env.OPENSUBTITLES_API_KEY;
  if (!apiKey) return {};

  const subtitles: Record<string, string> = {};

  for (const lang of languages) {
    try {
      const params: Record<string, string> = {
        imdb_id: imdbId,
        languages: lang,
      };
      if (season !== undefined) params.season_number = String(season);
      if (episode !== undefined) params.episode_number = String(episode);

      const searchResp = await fetch(
        `https://api.opensubtitles.com/api/v1/subtitles?${new URLSearchParams(params)}`,
        {
          headers: {
            'Api-Key': apiKey,
            'User-Agent': 'StreamVault v1.0',
          },
          signal: AbortSignal.timeout(10000),
        },
      );

      if (!searchResp.ok) continue;

      const searchData = await searchResp.json();
      const subData = searchData?.data?.[0];
      if (!subData) continue;

      const fileId = subData.attributes?.files?.[0]?.file_id;
      if (!fileId) continue;

      // Request download link
      const dlResp = await fetch('https://api.opensubtitles.com/api/v1/download', {
        method: 'POST',
        headers: {
          'Api-Key': apiKey,
          'Content-Type': 'application/json',
          'User-Agent': 'StreamVault v1.0',
        },
        body: JSON.stringify({ file_id: fileId }),
        signal: AbortSignal.timeout(10000),
      });

      if (!dlResp.ok) continue;

      const dlData = await dlResp.json();
      const downloadUrl = dlData?.link;
      if (!downloadUrl) continue;

      // Download the subtitle file
      const subResp = await fetch(downloadUrl, {
        signal: AbortSignal.timeout(15000),
      });

      if (!subResp.ok) continue;

      const srtContent = await subResp.text();
      if (!srtContent.includes('-->') || srtContent.length < 20) continue;

      // Convert SRT to VTT
      const vttContent = srtToVtt(srtContent);
      if (vttContent.length > 20) {
        subtitles[lang] = vttContent;
      }
    } catch {
      // Subtitle fetch failed for this language — non-critical
    }
  }

  return subtitles;
}

// ── Public API ──────────────────────────────────────────────────────────────

export interface SubtitleFetchResult {
  /** Downloaded subtitle VTT content, keyed by language code */
  subtitles: Record<string, string>;
  /** Subtitle track metadata for the player */
  subtitleTracks: SubtitleTrackInfo[];
}

const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  it: 'Italian',
  pt: 'Portuguese',
  ja: 'Japanese',
  ko: 'Korean',
  zh: 'Chinese',
  ar: 'Arabic',
  hi: 'Hindi',
  ru: 'Russian',
  tr: 'Turkish',
  pl: 'Polish',
  nl: 'Dutch',
  sv: 'Swedish',
  th: 'Thai',
  uk: 'Ukrainian',
};

/**
 * Fetch subtitles from external sources for downloaded content.
 *
 * Called by the download service when the HLS m3u8 manifest doesn't
 * include subtitle tracks (which is the common case for free streaming CDNs).
 *
 * Strategy:
 * 1. Get IMDB ID from TMDB API (using content's TMDB ID)
 * 2. Try server-side subtitle API first (API keys stay server-side)
 * 3. Fall back to direct SubDL API if server API didn't find subtitles
 * 4. Fall back to OpenSubtitles API for any remaining missing languages
 *
 * @param contentId TMDB ID of the content
 * @param mediaType 'movie' or 'tv'
 * @param preferredSubtitles User's preferred subtitle languages (empty = English only)
 * @param season Season number (for TV shows)
 * @param episode Episode number (for TV shows)
 */
export async function fetchExternalSubtitles(
  contentId: string | number,
  mediaType: 'movie' | 'tv',
  preferredSubtitles: string[],
  season?: number,
  episode?: number,
): Promise<SubtitleFetchResult> {
  const result: SubtitleFetchResult = {
    subtitles: {},
    subtitleTracks: [],
  };

  // Default to English if no preference set
  const languages = preferredSubtitles.length > 0 ? preferredSubtitles : ['en'];

  try {
    // Step 1: Get IMDB ID from TMDB
    const imdbId = await getImdbId(contentId, mediaType);
    if (!imdbId) {
      console.log(`[SV Subtitles] No IMDB ID found for TMDB ${mediaType}/${contentId} — skipping external subtitle fetch`);
      return result;
    }

    console.log(`[SV Subtitles] Found IMDB ID ${imdbId} for TMDB ${mediaType}/${contentId}, searching for subtitles in: ${languages.join(', ')}`);

    // Step 2: Try server-side API first (API keys stay server-side)
    let subs = await fetchFromServerApi(imdbId, languages, season, episode);

    // Step 3: If server API didn't return results, try direct client-side SubDL
    const missingFromServer = languages.filter(l => !subs[l]);
    if (missingFromServer.length > 0) {
      const subdlSubs = await fetchFromSubdl(imdbId, missingFromServer, season, episode);
      Object.assign(subs, subdlSubs);
    }

    // Step 4: Fall back to OpenSubtitles for any remaining missing languages
    const missingLangs = languages.filter(l => !subs[l]);
    if (missingLangs.length > 0) {
      const osSubs = await fetchFromOpenSubtitles(imdbId, missingLangs, season, episode);
      Object.assign(subs, osSubs);
    }

    // Build result
    if (Object.keys(subs).length > 0) {
      result.subtitles = subs;
      result.subtitleTracks = Object.keys(subs).map((lang, index) => ({
        language: lang,
        name: LANGUAGE_NAMES[lang] || lang,
        isDefault: index === 0,
        isForced: false,
      }));

      console.log(
        `[SV Subtitles] ✓ Fetched ${Object.keys(subs).length} subtitle track(s) ` +
        `from external sources: ${Object.keys(subs).join(', ')}`,
      );
    } else {
      console.log(`[SV Subtitles] No external subtitles found for IMDB ${imdbId}`);
    }
  } catch (err) {
    console.warn(`[SV Subtitles] External subtitle fetch failed:`, err instanceof Error ? err.message : err);
  }

  return result;
}
