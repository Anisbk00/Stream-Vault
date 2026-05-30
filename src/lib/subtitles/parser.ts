import type { SubtitleCue } from '@/types/subtitles';

/**
 * Parse SRT subtitle format.
 * Handles both comma and dot millisecond separators.
 * Strips HTML tags and normalizes whitespace.
 */
export function parseSRT(text: string): SubtitleCue[] {
  const cues: SubtitleCue[] = [];

  // Normalize line endings and split into blocks
  const blocks = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim().split(/\n\n+/);

  for (const block of blocks) {
    const lines = block.split('\n').map((l) => l.trim());
    if (lines.length < 3) continue;

    // Skip index lines and WEBVTT headers — find the time line
    let timeLineIdx = -1;
    for (let i = 0; i < Math.min(lines.length, 3); i++) {
      if (lines[i].includes('-->')) {
        timeLineIdx = i;
        break;
      }
    }
    if (timeLineIdx === -1) continue;

    const timeMatch = lines[timeLineIdx].match(
      /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{2,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{2,3})/,
    );
    if (!timeMatch) continue;

    const start = toSeconds(
      parseInt(timeMatch[1]),
      parseInt(timeMatch[2]),
      parseInt(timeMatch[3]),
      parseInt(timeMatch[4].padEnd(3, '0')),
    );
    const end = toSeconds(
      parseInt(timeMatch[5]),
      parseInt(timeMatch[6]),
      parseInt(timeMatch[7]),
      parseInt(timeMatch[8].padEnd(3, '0')),
    );

    // Text is everything after the time line
    const textLines = lines.slice(timeLineIdx + 1);
    if (textLines.length === 0) continue;

    const text = textLines
      .map((l) => l.replace(/<[^>]*>/g, '').trim()) // strip HTML tags
      .filter(Boolean)
      .join('\n');

    if (text.length === 0) continue;

    cues.push({ start, end, text });
  }

  return cues;
}

/**
 * Parse WebVTT subtitle format.
 * Handles both . and : as time separators.
 */
export function parseVTT(text: string): SubtitleCue[] {
  const cues: SubtitleCue[] = [];

  // Normalize line endings
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();

  // Skip WEBVTT header and any metadata
  const blocks = normalized.split(/\n\n+/);

  for (const block of blocks) {
    if (block.startsWith('WEBVTT')) continue;

    const lines = block.split('\n').map((l) => l.trim());
    if (lines.length < 2) continue;

    // Find the time line
    let timeLineIdx = -1;
    for (let i = 0; i < Math.min(lines.length, 3); i++) {
      if (lines[i].includes('-->')) {
        timeLineIdx = i;
        break;
      }
    }
    if (timeLineIdx === -1) continue;

    const timeMatch = lines[timeLineIdx].match(
      /(\d{1,2}):(\d{2}):(\d{2})[.](\d{2,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[.](\d{2,3})/,
    );
    if (!timeMatch) continue;

    const start = toSeconds(
      parseInt(timeMatch[1]),
      parseInt(timeMatch[2]),
      parseInt(timeMatch[3]),
      parseInt(timeMatch[4].padEnd(3, '0')),
    );
    const end = toSeconds(
      parseInt(timeMatch[5]),
      parseInt(timeMatch[6]),
      parseInt(timeMatch[7]),
      parseInt(timeMatch[8].padEnd(3, '0')),
    );

    const textLines = lines.slice(timeLineIdx + 1);
    if (textLines.length === 0) continue;

    const text = textLines
      .map((l) => l.replace(/<[^>]*>/g, '').trim())
      .filter(Boolean)
      .join('\n');

    if (text.length === 0) continue;

    cues.push({ start, end, text });
  }

  return cues;
}

/** Auto-detect format (SRT or VTT) and parse */
export function parseSubtitles(text: string): SubtitleCue[] {
  if (text.trim().startsWith('WEBVTT')) {
    return parseVTT(text);
  }
  return parseSRT(text);
}

function toSeconds(hours: number, minutes: number, seconds: number, ms: number): number {
  return hours * 3600 + minutes * 60 + seconds + ms / 1000;
}
