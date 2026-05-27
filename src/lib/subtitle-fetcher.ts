/**
 * External Subtitle Fetcher
 *
 * When an HLS m3u8 manifest doesn't include #EXT-X-MEDIA TYPE=SUBTITLES
 * (which is common for free streaming CDNs), this module fetches subtitles
 * from external sources as a fallback.
 *
 * Strategy: All API calls go through our server-side /api/subtitles route.
 * This keeps API keys server-side (TMDB_API_KEY, SUBDL_API_KEY, etc.)
 * and avoids client-side env var issues.
 *
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
 * Called by the download service AFTER the video download is complete,
 * as a non-blocking fire-and-forget step.
 *
 * Uses the server-side /api/subtitles route which:
 * 1. Resolves TMDB ID → IMDB ID (server-side, API key available)
 * 2. Searches SubDL and OpenSubtitles in parallel (API keys server-side)
 * 3. Returns subtitle download URLs
 *
 * Then this function downloads each subtitle file and converts SRT → VTT.
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
    // Call our server-side API route — it handles TMDB→IMDB resolution
    // and searches both SubDL + OpenSubtitles with server-side API keys.
    const params = new URLSearchParams({
      tmdb_id: String(contentId),
      type: mediaType,
      languages: languages.join(','),
    });
    if (season !== undefined) params.set('season', String(season));
    if (episode !== undefined) params.set('episode', String(episode));

    console.log(
      `[SV Subtitles] Searching external subtitles for TMDB ${mediaType}/${contentId}, ` +
      `languages: ${languages.join(', ')}`,
    );

    const resp = await fetch(`/api/subtitles?${params}`, {
      signal: AbortSignal.timeout(20000),
    });

    if (!resp.ok) {
      console.log(`[SV Subtitles] Server API returned ${resp.status} — no external subtitles`);
      return result;
    }

    const data = await resp.json();
    const subs = data?.subtitles as Array<{
      lang: string;
      url?: string;
      fileId?: number;
      name?: string;
      provider: string;
    }> | undefined;

    if (!subs || subs.length === 0) {
      console.log(`[SV Subtitles] No external subtitles found for TMDB ${mediaType}/${contentId}`);
      return result;
    }

    // Download each subtitle file
    for (const sub of subs) {
      try {
        // OpenSubtitles entries have fileId but no direct URL — needs
        // a separate download link request which requires server-side API key.
        // Skip those for now; SubDL provides direct download URLs.
        if (sub.provider === 'opensubtitles' || !sub.url) continue;

        // Download the subtitle file from SubDL
        const subResp = await fetch(sub.url, {
          signal: AbortSignal.timeout(15000),
        });
        if (!subResp.ok) continue;

        const srtContent = await subResp.text();

        // Validate it looks like a subtitle file
        if (!srtContent.includes('-->') || srtContent.length < 20) continue;

        // Convert SRT to VTT
        const vttContent = srtToVtt(srtContent);
        if (vttContent.length > 20) {
          result.subtitles[sub.lang] = vttContent;
        }
      } catch {
        // Skip failed subtitle download — non-critical
      }
    }

    // Build subtitle track metadata for the player
    if (Object.keys(result.subtitles).length > 0) {
      result.subtitleTracks = Object.keys(result.subtitles).map((lang, index) => ({
        language: lang,
        name: LANGUAGE_NAMES[lang] || lang,
        isDefault: index === 0,
        isForced: false,
      }));

      console.log(
        `[SV Subtitles] ✓ Fetched ${Object.keys(result.subtitles).length} subtitle track(s) ` +
        `from external sources: ${Object.keys(result.subtitles).join(', ')}`,
      );
    } else {
      console.log(`[SV Subtitles] No subtitle files could be downloaded for TMDB ${mediaType}/${contentId}`);
    }
  } catch (err) {
    console.warn(
      `[SV Subtitles] External subtitle fetch failed:`,
      err instanceof Error ? err.message : err,
    );
  }

  return result;
}
