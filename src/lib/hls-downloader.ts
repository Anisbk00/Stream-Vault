// HLS Downloader Engine
// Fetches HLS m3u8 manifests, selects quality, downloads segments via proxy,
// concatenates them into a single blob, and saves to the user's device.

const PROXY_BASE = '/api/stream/proxy';

/** Build a proxy URL. The proxy handles referer fallback automatically. */
function proxyUrl(targetUrl: string, referer?: string): string {
  let base = `${PROXY_BASE}?url=${encodeURIComponent(targetUrl)}`;
  if (referer) base += `&referer=${encodeURIComponent(referer)}`;
  return base;
}

// ── Global concurrency semaphore ─────────────────────────────────────────────
// Caps total concurrent proxy requests across ALL active downloads.
// Without this, 3 downloads × 3 workers = 9+ concurrent requests → Vercel 503.
// The semaphore is shared at module level — all download instances cooperate.
const MAX_CONCURRENT_REQUESTS = 4;
let _activeRequests = 0;
const _requestQueue: Array<() => void> = [];

function acquireRequestSlot(): Promise<void> {
  return new Promise((resolve) => {
    if (_activeRequests < MAX_CONCURRENT_REQUESTS) {
      _activeRequests++;
      resolve();
    } else {
      _requestQueue.push(() => {
        _activeRequests++;
        resolve();
      });
    }
  });
}

function releaseRequestSlot(): void {
  _activeRequests = Math.max(0, _activeRequests - 1);
  const next = _requestQueue.shift();
  if (next) next();
}

// ── Retry with exponential backoff ──────────────────────────────────────────
const MAX_RETRIES = 5;
const RETRYABLE_STATUS_CODES = new Set([502, 503, 429]);

/** 503 gets longer initial backoff (upstream CDN overloaded) */
const BACKOFF_BASE_MS = 2000;
const BACKOFF_MAX_MS = 12000;

/** Delay between consecutive segment downloads to avoid CDN rate-limiting */
const INTER_SEGMENT_DELAY_MS = 300;

/** When consecutive failures exceed this, switch to aggressive backoff */
const CONSECUTIVE_FAILURE_THRESHOLD = 3;
const AGGRESSIVE_INTER_DELAY_MS = 1500;

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithRetry(
  url: string,
  signal?: AbortSignal,
  maxRetries = MAX_RETRIES,
): Promise<Response> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (signal?.aborted) {
      throw new DOMException('Download aborted', 'AbortError');
    }

    try {
      // Wait for a slot in the global semaphore
      await acquireRequestSlot();
      try {
        const response = await fetch(url, { signal });
        // Retry on rate-limit / server-overload errors
        if (RETRYABLE_STATUS_CODES.has(response.status) && attempt < maxRetries) {
          lastError = new Error(`Server returned ${response.status}`);
          response.body?.cancel();
          // Exponential backoff: 2s, 4s, 8s, 12s, 12s (capped)
          const backoff = Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_MAX_MS);
          await sleep(backoff);
          continue;
        }
        return response;
      } finally {
        releaseRequestSlot();
      }
    } catch (err) {
      releaseRequestSlot(); // ensure slot is released on network error too
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw err;
      }
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < maxRetries) {
        const backoff = Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_MAX_MS);
        await sleep(backoff);
        continue;
      }
    }
  }

  throw lastError || new Error('All retries exhausted');
}

export interface DownloadTask {
  id: string;
  contentId: string | number;
  title: string;
  mediaType: 'movie' | 'tv';
  season?: number;
  episode?: number;
  quality: string;
  status: 'pending' | 'downloading' | 'paused' | 'completed' | 'error';
  progress: number; // 0-100
  downloadedBytes: number;
  totalBytes: number;
  speed: number; // bytes/sec
  eta: number; // seconds remaining
  url: string; // source m3u8 or direct video URL
  posterUrl?: string;
  year?: string;
  error?: string;
  startedAt: number;
  completedAt?: number;
  blob?: Blob;
  hasLocalCopy?: boolean; // true when blob is persisted in IndexedDB (survives reload)
  fileHandleName?: string; // name of saved file (for display, can't serialize FileHandle)
  /** Available subtitle tracks from the HLS manifest */
  subtitleTracks?: SubtitleTrackInfo[];
  /** Whether subtitles were downloaded alongside the video */
  hasSubtitles?: boolean;
  /** Whether this was an HLS download (vs direct MP4) */
  isHlsDownload?: boolean;
  /** Per-segment metadata for generating fake m3u8 on playback */
  segmentMeta?: SegmentMeta[];
}

type ProgressCallback = (task: DownloadTask) => void;

interface VariantInfo {
  bandwidth: number;
  url: string;
  resolution?: string;
}

export interface SubtitleTrackInfo {
  /** Language code (e.g. 'en', 'fr') */
  language: string;
  /** Display name from manifest (e.g. 'English', 'Français') */
  name: string;
  /** Whether this is the default subtitle track */
  isDefault: boolean;
  /** Whether this is an auto-generated (forced) track */
  isForced: boolean;
}

interface ParsedM3u8 {
  isMaster: boolean;
  segments: string[];
  variants?: VariantInfo[];
  subtitleTracks?: SubtitleTrackInfo[];
}

// Parse m3u8 content (master + media playlists)
function parseM3u8(content: string): ParsedM3u8 {
  const lines = content
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const isMaster = lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'));

  // Extract subtitle tracks from #EXT-X-MEDIA tags
  const subtitleTracks: SubtitleTrackInfo[] = [];
  for (const line of lines) {
    if (line.startsWith('#EXT-X-MEDIA') && line.includes('TYPE=SUBTITLES')) {
      const language = line.match(/LANGUAGE="([^"]*)"/)?.[1] || 'und';
      const name = line.match(/NAME="([^"]*)"/)?.[1] || language;
      const isDefault = line.includes('DEFAULT=YES');
      const isForced = line.includes('FORCED=YES');
      subtitleTracks.push({ language, name, isDefault, isForced });
    }
  }

  if (isMaster) {
    const variants: VariantInfo[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
        const bandwidth = parseInt(
          lines[i].match(/BANDWIDTH=(\d+)/)?.[1] || '0',
          10
        );
        const resolution = lines[i].match(/RESOLUTION=(\d+x\d+)/)?.[1];
        // Next non-comment line is the URL
        const urlLine = lines[i + 1];
        if (urlLine && !urlLine.startsWith('#')) {
          variants.push({ bandwidth, url: urlLine, resolution });
        }
      }
    }
    return { isMaster: true, segments: [], variants, subtitleTracks: subtitleTracks.length > 0 ? subtitleTracks : undefined };
  }

  // Media playlist - extract segment URLs
  const segments: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('#') && lines[i].includes('.')) {
      segments.push(lines[i]);
    }
  }
  return { isMaster: false, segments, variants: undefined, subtitleTracks: subtitleTracks.length > 0 ? subtitleTracks : undefined };
}

// Extract segment URLs, their #EXTINF durations, and discontinuity markers from an m3u8 media playlist
function extractSegmentsWithDurations(playlistContent: string, baseUrl: string): { urls: string[]; durations: number[]; discontinuities: boolean[] } {
  const lines = playlistContent.split('\n').map(l => l.trim()).filter(Boolean);
  const urls: string[] = [];
  const durations: number[] = [];
  const discontinuities: boolean[] = [];
  // Track whether the next segment is preceded by #EXT-X-DISCONTINUITY
  let nextIsDiscontinuity = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === '#EXT-X-DISCONTINUITY') {
      nextIsDiscontinuity = true;
      continue;
    }
    if (lines[i].startsWith('#EXTINF:')) {
      const duration = parseFloat(lines[i].split(':')[1]) || 0;
      // Find next non-comment line (the segment URL)
      for (let j = i + 1; j < lines.length; j++) {
        if (!lines[j].startsWith('#')) {
          urls.push(resolveUrl(baseUrl, lines[j]));
          durations.push(duration);
          discontinuities.push(nextIsDiscontinuity);
          nextIsDiscontinuity = false;
          break;
        }
      }
    }
  }
  return { urls, durations, discontinuities };
}

// Resolve relative URLs
function resolveUrl(base: string, relative: string): string {
  if (relative.startsWith('http')) return relative;
  try {
    return new URL(relative, base).href;
  } catch {
    return base.substring(0, base.lastIndexOf('/') + 1) + relative;
  }
}

// Select quality variant
function selectVariant(
  variants: VariantInfo[],
  quality: string
): string {
  if (variants.length === 0) return '';

  // Sort by bandwidth ascending
  const sorted = [...variants].sort((a, b) => a.bandwidth - b.bandwidth);

  if (quality === 'auto' || quality === '1080p') {
    // Pick highest
    return sorted[sorted.length - 1].url;
  }
  if (quality === '720p') {
    // Pick ~2-3Mbps or closest
    const target = sorted.find(
      (v) => v.bandwidth >= 2000000 && v.bandwidth <= 4000000
    );
    return target?.url || sorted[Math.floor(sorted.length * 0.7)].url;
  }
  if (quality === '480p') {
    // Pick lowest reasonable
    return sorted[Math.floor(sorted.length * 0.3)].url;
  }
  // Default to middle
  return sorted[Math.floor(sorted.length / 2)].url;
}

// Download a single segment through proxy with retry + global semaphore
async function fetchSegment(
  url: string,
  signal?: AbortSignal,
  referer?: string,
): Promise<ArrayBuffer> {
  const response = await fetchWithRetry(proxyUrl(url, referer), signal);
  if (!response.ok) {
    throw new Error(`Failed to fetch segment: ${response.status}`);
  }
  return response.arrayBuffer();
}

export interface SegmentMeta {
  /** Byte offset in the concatenated blob */
  offset: number;
  /** Byte size of this segment */
  size: number;
  /** #EXTINF duration in seconds */
  duration: number;
  /** Whether an #EXT-X-DISCONTINUITY tag precedes this segment */
  discontinuity?: boolean;
}

export interface DownloadResult {
  blob: Blob;
  /** Individual segment buffers */
  segmentBuffers?: ArrayBuffer[];
  /** Per-segment metadata (offset, size, duration) for fake m3u8 generation */
  segmentMeta?: SegmentMeta[];
  /** Downloaded subtitle VTT content, keyed by language */
  subtitles?: Record<string, string>;
  /** Subtitle track metadata from the manifest */
  subtitleTracks?: SubtitleTrackInfo[];
}

// Main download function
export async function startDownload(
  task: DownloadTask,
  onProgress: ProgressCallback,
  abortSignal?: AbortSignal,
  referer?: string,
  preferredSubtitles?: string[],
): Promise<DownloadResult> {
  const startTime = Date.now();
  let blob: Blob;

  // Check if it's a direct video URL (mp4) or HLS (m3u8)
  if (
    task.url.endsWith('.mp4') ||
    task.url.endsWith('.mkv') ||
    !task.url.includes('.m3u8')
  ) {
    // Direct download
    onProgress({ ...task, status: 'downloading', progress: 0 });

    const response = await fetchWithRetry(proxyUrl(task.url, referer), abortSignal);
    const contentLength = parseInt(
      response.headers.get('Content-Length') || '0',
      10
    );
    const reader = response.body?.getReader();

    if (!reader) throw new Error('No readable stream');

    const chunks: Uint8Array[] = [];
    let receivedLength = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (abortSignal?.aborted) {
        throw new DOMException('Download aborted', 'AbortError');
      }

      chunks.push(value);
      receivedLength += value.length;

      const progress =
        contentLength > 0
          ? Math.min(99, (receivedLength / contentLength) * 100)
          : 0;
      const elapsed = (Date.now() - startTime) / 1000;
      const speed = elapsed > 0 ? receivedLength / elapsed : 0;
      const eta = speed > 0 ? (contentLength - receivedLength) / speed : 0;

      onProgress({
        ...task,
        status: 'downloading',
        progress,
        downloadedBytes: receivedLength,
        totalBytes: contentLength,
        speed,
        eta,
      });
    }

    blob = new Blob(chunks.map(c => c.buffer as ArrayBuffer), { type: 'video/mp4' });
    // Direct download complete
  } else {
    // HLS download
    onProgress({ ...task, status: 'downloading', progress: 0 });

    // Step 1: Fetch m3u8 manifest
    const manifestResponse = await fetchWithRetry(proxyUrl(task.url, referer), abortSignal);
    const manifestContent = await manifestResponse.text();
    const parsed = parseM3u8(manifestContent);

    let segmentUrls: string[] = [];
    let segmentDurations: number[] = [];
    let segmentDiscontinuities: boolean[] = [];
    let subtitleTracks: SubtitleTrackInfo[] | undefined;

    if (parsed.isMaster && parsed.variants && parsed.variants.length > 0) {
      // Master playlist - select quality and fetch sub-playlist
      const variantUrl = selectVariant(parsed.variants, task.quality);
      const absoluteVariantUrl = resolveUrl(task.url, variantUrl);
      const subResponse = await fetchWithRetry(proxyUrl(absoluteVariantUrl, referer), abortSignal);
      const subContent = await subResponse.text();
      // Parse segments with durations and discontinuities from sub-playlist
      const { urls: segUrls, durations: segDurs, discontinuities: segDiscont } = extractSegmentsWithDurations(subContent, absoluteVariantUrl);
      segmentUrls = segUrls;
      segmentDurations = segDurs;
      segmentDiscontinuities = segDiscont;
      // Subtitle tracks come from the master manifest
      subtitleTracks = parsed.subtitleTracks;
    } else if (parsed.segments.length > 0) {
      // Direct media playlist
      const { urls: segUrls, durations: segDurs, discontinuities: segDiscont } = extractSegmentsWithDurations(manifestContent, task.url);
      segmentUrls = segUrls;
      segmentDurations = segDurs;
      segmentDiscontinuities = segDiscont;
      subtitleTracks = parsed.subtitleTracks;
    } else {
      throw new Error('No segments found in m3u8 playlist');
    }

    // Step 2: Download all segments
    const totalSegments = segmentUrls.length;
    const chunks: (Uint8Array | undefined)[] = new Array(totalSegments);
    let totalDownloadedBytes = 0;
    let estimatedTotalBytes = 0;

    // Download segments
    // (global semaphore caps total across all downloads to 4)
    const PER_DOWNLOAD_CONCURRENCY = 3;
    let completedSegments = 0;
    let nextSegmentIndex = 0;
    let failedSegments = 0;
    let consecutiveFailures = 0;

    const downloadNext = async (): Promise<void> => {
      while (nextSegmentIndex < segmentUrls.length) {
        const index = nextSegmentIndex++;
        const segUrl = segmentUrls[index];
        if (abortSignal?.aborted) {
          throw new DOMException('Download aborted', 'AbortError');
        }

        // Inter-segment delay to avoid overwhelming CDN
        if (completedSegments > 0) {
          const delay = consecutiveFailures >= CONSECUTIVE_FAILURE_THRESHOLD
            ? AGGRESSIVE_INTER_DELAY_MS
            : INTER_SEGMENT_DELAY_MS;
          await sleep(delay);
        }

        try {
          const data = await fetchSegment(segUrl, abortSignal, referer);
          chunks[index] = new Uint8Array(data);
          totalDownloadedBytes += data.byteLength;
          consecutiveFailures = 0; // reset on success
        } catch (err) {
          if (err instanceof DOMException && err.name === 'AbortError') {
            throw err;
          }
          failedSegments++;
          consecutiveFailures++;
        }

        completedSegments++;
        const progress = Math.min(
          99,
          (completedSegments / totalSegments) * 100
        );
        const elapsed = (Date.now() - startTime) / 1000;
        const speed = elapsed > 0 ? totalDownloadedBytes / elapsed : 0;
        const eta =
          speed > 0 ? (estimatedTotalBytes - totalDownloadedBytes) / speed : 0;

        onProgress({
          ...task,
          status: 'downloading',
          progress,
          downloadedBytes: totalDownloadedBytes,
          totalBytes: Math.max(estimatedTotalBytes, totalDownloadedBytes),
          speed,
          eta,
        });
      }
    };

    // Launch concurrent download workers (per-download concurrency)
    const workerCount = Math.min(PER_DOWNLOAD_CONCURRENCY, totalSegments);
    const workers = Array.from({ length: workerCount }, () => downloadNext());
    await Promise.all(workers);

    // ── Second pass: retry any failed segments ──────────────────────────
    // The initial concurrent pass may leave gaps when the CDN rate-limits
    // (503/429) — 5 retries with 2-12s backoff isn't always enough under
    // heavy concurrency. The second pass retries one segment at a time with
    // longer delays, which avoids rate-limiting. Missing segments cause
    // visible gaps in the video and corrupt the segment-index-to-meta
    // mapping used by the MemoryHlsLoader, so every segment must succeed.
    const failedIndices: number[] = [];
    for (let i = 0; i < chunks.length; i++) {
      if (chunks[i] === undefined) failedIndices.push(i);
    }

    if (failedIndices.length > 0) {
      const RETRY_PASS_MAX_ATTEMPTS = 10;
      const RETRY_PASS_DELAY_MS = 2000;

      for (const idx of failedIndices) {
        if (abortSignal?.aborted) {
          throw new DOMException('Download aborted', 'AbortError');
        }
        let succeeded = false;
        for (let attempt = 0; attempt < RETRY_PASS_MAX_ATTEMPTS; attempt++) {
          if (abortSignal?.aborted) {
            throw new DOMException('Download aborted', 'AbortError');
          }
          try {
            await sleep(RETRY_PASS_DELAY_MS * (attempt + 1)); // progressive delay: 2s, 4s, 6s...
            const data = await fetchSegment(segmentUrls[idx], abortSignal, referer);
            chunks[idx] = new Uint8Array(data);
            totalDownloadedBytes += data.byteLength;
            failedSegments--;
            succeeded = true;
            break;
          } catch {
            // Continue retrying
          }
        }
        if (!succeeded) {
          throw new Error(
            `Segment ${idx + 1}/${totalSegments} failed after exhaustive retry. ` +
            'The server is rate-limiting. Try again later.'
          );
        }
      }
    }

    // Build segment buffers array — all segments are guaranteed present after retry pass.
    const segmentBuffers: ArrayBuffer[] = [];
    const segmentMeta: SegmentMeta[] = [];
    let runningOffset = 0;
    let skippedEmptySegments = 0;

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      if (!chunk || chunk.length === 0) {
        skippedEmptySegments++;
        // CRITICAL: Even if a segment is empty, we MUST push a placeholder in segmentMeta
        // to maintain index alignment. Without this, the MemoryHlsLoader byte offsets
        // will be wrong for ALL subsequent segments.
        if (chunk && chunk.length === 0) {
          console.warn(`[SV Download] Segment ${i} is EMPTY (0 bytes) — this will cause playback issues`);
          segmentMeta.push({
            offset: runningOffset,
            size: 0,
            duration: segmentDurations[i] || 10,
            discontinuity: segmentDiscontinuities[i] || false,
          });
        }
        continue;
      }

      const buf = chunk.buffer as ArrayBuffer;
      segmentBuffers.push(buf);

      // Keep segmentMeta for backward compatibility with old downloads that
      // use the MemoryHlsLoader path. New downloads will be remuxed to MP4.
      segmentMeta.push({
        offset: runningOffset,
        size: buf.byteLength,
        duration: segmentDurations[i] || 10,
        discontinuity: segmentDiscontinuities[i] || false,
      });
      runningOffset += buf.byteLength;
    }

    console.log(
      `[SV Download] Segment assembly: ${segmentBuffers.length} buffers, ${skippedEmptySegments} empty/skipped, ` +
      `total ${(runningOffset / 1024 / 1024).toFixed(2)} MB, ` +
      `segmentMeta count: ${segmentMeta.length} (expected: ${chunks.length})`,
    );

    if (segmentMeta.length !== chunks.length) {
      console.error(
        `[SV Download] INDEX MISMATCH: segmentMeta has ${segmentMeta.length} entries but chunks has ${chunks.length}. ` +
        `This WILL cause MemoryHlsLoader byte-offset misalignment and playback corruption!`,
      );
    }

    // ── Remux TS → MP4 ──────────────────────────────────────────────────
    // Convert raw TS segments to a fragmented MP4 (fMP4) file that browsers
    // can play natively. This eliminates HLS.js from the offline playback
    // path, fixing freezing and A/V desync caused by HLS.js's network-
    // oriented buffer management. Netflix and all major platforms remux
    // downloaded content to MP4 for native playback.
    //
    // A single Transmuxer instance processes ALL segments sequentially,
    // ensuring continuous base_media_decode_time across the entire video.
    // The previous per-segment transmux approach produced discontinuous
    // decode times in each moof box, causing "video freezes, audio plays".
    try {
      console.log(`[SV Download] Attempting TS→MP4 remux with ${segmentBuffers.length} segment buffers...`);
      const { remuxTsToMp4 } = await import('@/lib/ts-to-mp4');
      blob = await remuxTsToMp4(segmentBuffers, task.id);
      console.log(
        `[SV Download] Remux SUCCESS — fMP4 blob: ${blob.size} bytes, type: '${blob.type}'`,
      );
    } catch (remuxErr) {
      // Remux failed — fall back to raw TS blob + MemoryHlsLoader path.
      // This preserves backward compatibility and handles edge cases where
      // the TS data uses codecs mux.js doesn't support.
      console.error(
        `[SV Download] Remux FAILED — falling back to raw TS + MemoryHlsLoader path.`,
        `Error: ${remuxErr instanceof Error ? remuxErr.message : String(remuxErr)}`,
        `This is the LIKELY CAUSE of freezing/desync if it keeps happening.`,
        `Raw TS playback via HLS.js MemoryHlsLoader is inherently fragile.`,
      );
      blob = new Blob(segmentBuffers, { type: 'video/mp2t' });
      console.log(
        `[SV Download] Fallback: raw TS blob created — ${blob.size} bytes, type: '${blob.type}'`,
      );
    }
    // HLS download complete

    // Step 3: Download subtitles if available
    const subtitles: Record<string, string> = {};
    if (subtitleTracks && subtitleTracks.length > 0) {
      // Download each subtitle track independently using its own URI from
      // the #EXT-X-MEDIA tag in the master manifest. Previously this code
      // required a single "subGroupLine" with URI= to exist, which blocked
      // all subtitle downloads when the first EXT-X-MEDIA line didn't have
      // a URI attribute (some manifests use GROUP-ID references instead).
      for (const subTrack of subtitleTracks) {
        // Filter by user's preferred subtitle languages (if set)
        // Empty preferredSubtitles = download all available
        if (preferredSubtitles && preferredSubtitles.length > 0 && !preferredSubtitles.includes(subTrack.language)) continue;
        const lang = subTrack.language;
        // Find the subtitle media tag for this language
        const mediaLine = manifestContent.split('\n').find(
          (l) => l.includes('#EXT-X-MEDIA') && l.includes('TYPE=SUBTITLES') && l.includes(`LANGUAGE="${lang}"`)
        );
        if (!mediaLine) continue;

        // Find URI for this specific track
        const trackUriMatch = mediaLine.match(/URI="([^"]*)"/);
        if (!trackUriMatch) continue;

        const trackPlaylistUrl = resolveUrl(task.url, trackUriMatch[1]);
        try {
          const trackResp = await fetchWithRetry(proxyUrl(trackPlaylistUrl, referer), abortSignal);
          const trackText = await trackResp.text();
          const trackLines = trackText.split('\n').map(l => l.trim()).filter(Boolean);

          // Collect subtitle segment URLs
          const subSegments: string[] = [];
          for (let i = 0; i < trackLines.length; i++) {
            if (!trackLines[i].startsWith('#') && trackLines[i].includes('.')) {
              subSegments.push(resolveUrl(trackPlaylistUrl, trackLines[i]));
            }
          }

          if (subSegments.length > 0) {
            // Download all subtitle segments and merge
            let mergedVtt = 'WEBVTT\n\n';
            let cumulOffset = 0;

            for (const segUrl of subSegments) {
              try {
                const segResp = await fetchWithRetry(proxyUrl(segUrl, referer), abortSignal);
                let segText = await segResp.text();

                // Strip WEBVTT header from subsequent segments
                if (mergedVtt.length > 8) {
                  segText = segText.replace(/^WEBVTT[^\n]*\n*/i, '');
                }

                // Adjust timestamps if there are multiple segments
                if (subSegments.length > 1 && cumulOffset > 0) {
                  segText = adjustVttTimestamps(segText, cumulOffset);
                }

                // Estimate duration from last timestamp for offset calc
                const lastTs = parseLastVttTimestamp(segText);
                cumulOffset += lastTs;

                mergedVtt += segText + '\n';
              } catch {
                // Skip failed subtitle segments — non-critical
              }
            }

            if (mergedVtt.length > 10) {
              subtitles[lang] = mergedVtt;
            }
          }
        } catch {
          // Skip failed subtitle track — non-critical
        }
      }
    }

    return {
      blob,
      segmentBuffers,
      segmentMeta: segmentMeta.length > 0 ? segmentMeta : undefined,
      subtitles: Object.keys(subtitles).length > 0 ? subtitles : undefined,
      subtitleTracks,
    };
  }

  return { blob };
}

// File System Access API types
interface SaveFilePickerOptions {
  suggestedName?: string;
  types?: Array<{
    description: string;
    accept: Record<string, string[]>;
  }>;
}

interface FileHandleWithWrite {
  createWritable: () => Promise<{
    write: (data: Blob) => Promise<void>;
    close: () => Promise<void>;
  }>;
}

// Check if File System Access API is available
function hasFileSystemAccess(): boolean {
  return 'showSaveFilePicker' in window;
}

// Show save file picker
async function showSaveFilePicker(
  options: SaveFilePickerOptions
): Promise<FileHandleWithWrite> {
  return (
    window as unknown as {
      showSaveFilePicker: (
        opts: SaveFilePickerOptions
      ) => Promise<FileHandleWithWrite>;
    }
  ).showSaveFilePicker(options);
}

// Save blob to user's filesystem using File System Access API (or fallback)
export async function saveDownload(
  blob: Blob,
  filename: string
): Promise<{ saved: boolean; fileName: string; filePath?: string }> {
  // Try File System Access API (Chrome/Edge)
  if (hasFileSystemAccess()) {
    try {
      const handle = await showSaveFilePicker({
        suggestedName: filename,
        types: [
          {
            description: 'Video File',
            accept: {
              'video/mp4': ['.mp4'],
              'video/mp2t': ['.ts'],
              'video/*': ['.mp4', '.ts', '.mkv'],
            },
          },
        ],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();

      return { saved: true, fileName: filename };
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return { saved: false, fileName: filename }; // User cancelled
      }
      // Fall through to fallback
    }
  }

  // Fallback: trigger browser download
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 10000);

  return { saved: true, fileName: filename };
}

// Format bytes to human readable
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

// Format seconds to human readable
export function formatEta(seconds: number): string {
  if (seconds <= 0 || !isFinite(seconds)) return '';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

// ── Subtitle utilities ──────────────────────────────────────────────────────

/** Parse the last timestamp from a VTT segment to calculate cumulative offset */
function parseLastVttTimestamp(vtt: string): number {
  // Match both HH:MM:SS.mmm and MM:SS.mmm formats
  const matches = vtt.matchAll(/(\d{2}):(\d{2})(?::(\d{2}))?\.(\d{3})/g);
  let lastMs = 0;
  for (const m of matches) {
    const hasHours = m[3] !== undefined;
    const h = hasHours ? parseInt(m[1], 10) : 0;
    const min = hasHours ? parseInt(m[2], 10) : parseInt(m[1], 10);
    const s = hasHours ? parseInt(m[3], 10) : parseInt(m[2], 10);
    const ms = parseInt(m[4], 10);
    lastMs = Math.max(lastMs, h * 3600000 + min * 60000 + s * 1000 + ms);
  }
  return lastMs;
}

/** Adjust all timestamps in a VTT segment by adding an offset in ms */
function adjustVttTimestamps(vtt: string, offsetMs: number): string {
  // Match both HH:MM:SS.mmm and MM:SS.mmm formats
  return vtt.replace(
    /(\d{2}):(\d{2})(?::(\d{2}))?\.(\d{3})/g,
    (_match, p1, p2, p3, p4) => {
      const hasHours = p3 !== undefined;
      const h = hasHours ? parseInt(p1, 10) : 0;
      const min = hasHours ? parseInt(p2, 10) : parseInt(p1, 10);
      const s = hasHours ? parseInt(p3, 10) : parseInt(p2, 10);
      const ms = parseInt(p4, 10);
      let totalMs = h * 3600000 + min * 60000 + s * 1000 + ms;
      totalMs += offsetMs;
      const newH = Math.floor(totalMs / 3600000);
      totalMs %= 3600000;
      const newM = Math.floor(totalMs / 60000);
      totalMs %= 60000;
      const newS = Math.floor(totalMs / 1000);
      const newMs = totalMs % 1000;
      // Always output in HH:MM:SS.mmm format for consistency
      return `${String(newH).padStart(2, '0')}:${String(newM).padStart(2, '0')}:${String(newS).padStart(2, '0')}.${String(newMs).padStart(3, '0')}`;
    }
  );
}
