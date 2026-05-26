/**
 * Custom HLS.js loader that serves segment data from an in-memory Blob.
 *
 * The Blob is stored directly (no upfront ArrayBuffer conversion), and each
 * segment is extracted on demand via `blob.slice().arrayBuffer()`. This avoids
 * allocating the entire video as a single ArrayBuffer (which causes "Share too
 * large" errors for 50MB+ downloads) and reduces peak memory to one segment
 * (~700KB) at a time.
 *
 * URL scheme: mem://{playbackId}/playlist.m3u8  → manifest
 *             mem://{playbackId}/seg/{index}     → segment
 *
 * Segments are delivered immediately after extraction (no artificial pacing).
 * The previous pacing approach (simulating 8 Mbps throughput) caused buffer
 * stalls: HLS.js's internal scheduler delayed segment requests thinking the
 * network was slow, and the deliberate delay made each segment take 100-800ms
 * longer to arrive. This created a feedback loop where the buffer repeatedly
 * drained → stall → refill → play briefly → drain again. For in-memory data,
 * instant delivery is correct — the browser's MSE pipeline naturally throttles
 * appends through the SourceBuffer update queue.
 */

import type { Loader, LoaderContext, LoaderConfiguration, LoaderCallbacks, LoaderResponse, LoaderStats } from 'hls.js';

interface SegmentInfo {
  offset: number;
  size: number;
  duration: number;
}

interface PlaybackData {
  m3u8: string;
  /** The raw concatenated TS Blob — segments are extracted via blob.slice() */
  blob: Blob;
  segments: SegmentInfo[];
}

const _playbacks = new Map<string, PlaybackData>();

/** Register segment data for a playback session */
export function registerPlayback(
  id: string,
  m3u8: string,
  blob: Blob,
  segments: SegmentInfo[],
): void {
  _playbacks.set(id, { m3u8, blob, segments });
  console.log(
    `[SV MemoryLoader] registerPlayback('${id}'): blob=${blob.size} bytes, ` +
    `${segments.length} segments, m3u8 length=${m3u8.length}`,
  );
  // Validate segment offsets against blob size
  let offsetErrors = 0;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const end = seg.offset + seg.size;
    if (seg.offset < 0 || end > blob.size) {
      offsetErrors++;
      console.error(
        `[SV MemoryLoader] INVALID segment ${i}: offset=${seg.offset}, size=${seg.size}, ` +
        `end=${end}, blob.size=${blob.size} — OUT OF BOUNDS`,
      );
    }
  }
  if (offsetErrors > 0) {
    console.error(
      `[SV MemoryLoader] ${offsetErrors}/${segments.length} segments have INVALID byte offsets! ` +
      `This WILL cause playback corruption.`,
    );
  } else {
    console.log(`[SV MemoryLoader] All ${segments.length} segment offsets validated ✓`);
  }
}

/** Free segment data for a playback session */
export function unregisterPlayback(id: string): void {
  const existed = _playbacks.delete(id);
  console.log(`[SV MemoryLoader] unregisterPlayback('${id}'): existed=${existed}`);
}

/** Check if playback data exists */
export function hasPlayback(id: string): boolean {
  return _playbacks.has(id);
}

/** Parse mem:// URL into playbackId and path */
function parseMemoryUrl(url: string): { playbackId: string; path: string } | null {
  const match = url.match(/^mem:\/\/([^/]+)\/(.+)$/);
  if (!match) return null;
  return { playbackId: match[1], path: match[2] };
}

/** Create a LoaderStats object with in-memory load timing */
function createStats(loadedBytes: number): LoaderStats {
  const now = performance.now();
  return {
    aborted: false,
    loaded: loadedBytes,
    retry: 0,
    total: loadedBytes,
    chunkCount: 1,
    bwEstimate: 100_000_000, // 100 Mbps — in-memory delivery is near-instant
    loading: { start: now, first: now, end: now },
    parsing: { start: now, end: now },
    buffering: { start: now, end: now },
  };
}

/**
 * Custom HLS.js loader implementation.
 *
 * Implements the `Loader<T>` interface from hls.js v1.6.x.
 * Intercepts load requests for `mem://` URLs and returns data from the
 * in-memory playback store.
 *
 * Key design decisions:
 * - Manifest response: `data` is a STRING (not ArrayBuffer). HLS.js expects
 *   a string when `context.responseType === 'text'`. Passing ArrayBuffer was
 *   the root cause of `internalException` errors that prevented playback.
 * - Segment response: `data` is an ArrayBuffer (binary TS data), extracted
 *   lazily from the Blob via `blob.slice().arrayBuffer()`.
 * - Segment extraction is async — the load() method starts the extraction
 *   and fires callbacks via setTimeout once the data is ready.
 * - Segments are delivered INSTANTLY (no artificial pacing). The MSE
 *   SourceBuffer's internal update queue provides natural backpressure.
 *   Previous pacing caused buffer stalls and freeze-loop behavior.
 *
 * Usage:
 * ```
 * new Hls({
 *   loader: MemoryHlsLoader,
 *   fLoader: MemoryHlsLoader,
 *   enableWorker: false,
 * });
 * ```
 */
export class MemoryHlsLoader implements Loader<LoaderContext> {
  context: LoaderContext | null = null;
  stats: LoaderStats;
  private _aborted = false;

  constructor(_config: unknown) {
    this.stats = createStats(0);
  }

  destroy(): void {
    this._aborted = true;
    this.context = null;
  }

  abort(): void {
    this._aborted = true;
    this.context = null;
  }

  load(context: LoaderContext, _config: LoaderConfiguration, callbacks: LoaderCallbacks<LoaderContext>): void {
    this.context = context;
    this._aborted = false;

    const parsed = parseMemoryUrl(context.url);
    if (!parsed) {
      console.error(`[SV MemoryLoader] Invalid URL: ${context.url}`);
      setTimeout(() => callbacks.onError(
        { code: -1, text: `MemoryHlsLoader: invalid URL scheme: ${context.url}` },
        context,
        null,
        this.stats,
      ));
      return;
    }

    const playback = _playbacks.get(parsed.playbackId);
    if (!playback) {
      console.error(`[SV MemoryLoader] Playback '${parsed.playbackId}' NOT FOUND — available: [${Array.from(_playbacks.keys()).join(', ')}]`);
      setTimeout(() => callbacks.onError(
        { code: -1, text: `MemoryHlsLoader: playback "${parsed.playbackId}" not found` },
        context,
        null,
        this.stats,
      ));
      return;
    }

    // ── Manifest: mem://{id}/playlist.m3u8 ──
    if (parsed.path === 'playlist.m3u8') {
      this.stats = createStats(playback.m3u8.length);
      console.log(
        `[SV MemoryLoader] Manifest request for '${parsed.playbackId}': ${playback.m3u8.length} bytes, ` +
        `${playback.segments.length} segments`,
      );

      // CRITICAL: response.data MUST be a string for manifest responses.
      // HLS.js requests manifests with responseType='text' and expects
      // response.data to be a string.
      const response: LoaderResponse = {
        url: context.url,
        data: playback.m3u8, // string — HLS.js expects this for manifests
      };

      // CRITICAL: callbacks must be called asynchronously (via setTimeout).
      // HLS.js's internal state machine expects loader callbacks to fire after
      // load() returns — like XHR's onload event.
      setTimeout(() => {
        if (!this._aborted) {
          callbacks.onSuccess(response, this.stats, context, null);
        }
      }, 0);
      return;
    }

    // ── Segment: mem://{id}/seg/{index} ──
    const segMatch = parsed.path.match(/^seg\/(\d+)$/);
    if (!segMatch) {
      console.error(`[SV MemoryLoader] Invalid segment path: '${parsed.path}'`);
      setTimeout(() => callbacks.onError(
        { code: -1, text: `MemoryHlsLoader: invalid segment path: ${parsed.path}` },
        context,
        null,
        this.stats,
      ));
      return;
    }

    const index = parseInt(segMatch[1], 10);
    const segInfo = playback.segments[index];

    if (!segInfo) {
      console.error(
        `[SV MemoryLoader] Segment ${index} NOT FOUND — playback has ${playback.segments.length} segments (0-${playback.segments.length - 1})`,
      );
      setTimeout(() => callbacks.onError(
        { code: -1, text: `MemoryHlsLoader: segment index ${index} out of range (0-${playback.segments.length - 1})` },
        context,
        null,
        this.stats,
      ));
      return;
    }

    // Validate segment bounds against blob size
    const endByte = segInfo.offset + segInfo.size;
    if (segInfo.offset < 0 || endByte > playback.blob.size) {
      console.error(
        `[SV MemoryLoader] Segment ${index} OUT OF BOUNDS: offset=${segInfo.offset}, size=${segInfo.size}, ` +
        `end=${endByte}, blob.size=${playback.blob.size}`,
      );
      setTimeout(() => callbacks.onError(
        { code: -1, text: `MemoryHlsLoader: segment ${index} out of blob bounds` },
        context,
        null,
        this.stats,
      ));
      return;
    }

    // Extract segment lazily from the Blob — avoids allocating the full blob
    // as an ArrayBuffer upfront (which causes "Share too large" errors for
    // 50MB+ downloads). Each segment is ~700KB, well within safe limits.
    const segBlob = playback.blob.slice(segInfo.offset, endByte, 'video/mp2t');

    // Log first 5 and then every 50th segment to avoid console spam
    if (index < 5 || index % 50 === 0) {
      console.log(
        `[SV MemoryLoader] Extracting segment ${index}: offset=${segInfo.offset}, size=${segInfo.size}, ` +
        `duration=${segInfo.duration.toFixed(3)}s, blob.size=${playback.blob.size}`,
      );
    }

    segBlob.arrayBuffer().then((segmentData) => {
      if (this._aborted) return; // aborted while extracting

      // Validate extracted data size matches expected size
      if (segmentData.byteLength !== segInfo.size) {
        console.error(
          `[SV MemoryLoader] SIZE MISMATCH for segment ${index}: expected ${segInfo.size} bytes, ` +
          `got ${segmentData.byteLength} bytes — this WILL cause playback corruption!`,
        );
      }

      this.stats = createStats(segmentData.byteLength);

      const response: LoaderResponse = {
        url: context.url,
        data: segmentData, // ArrayBuffer — HLS.js expects binary for segments
      };

      // Deliver immediately — no artificial pacing.
      // MSE's SourceBuffer update queue provides natural backpressure:
      // appendBuffer() is async, and subsequent appends queue until the
      // previous one completes. This prevents decoder overflow without
      // the artificial delays that caused buffer stalls.
      setTimeout(() => {
        if (!this._aborted) {
          callbacks.onSuccess(response, this.stats, context, null);
        }
      }, 0);
    }).catch((err) => {
      if (this._aborted) return;
      console.error(
        `[SV MemoryLoader] Failed to extract segment ${index}:`, err,
      );
      setTimeout(() => callbacks.onError(
        { code: -1, text: `MemoryHlsLoader: failed to extract segment ${index}: ${err}` },
        context,
        null,
        this.stats,
      ));
    });
  }

  getCacheAge(): number | null {
    return null;
  }

  getResponseHeader(_name: string): string | null {
    return null;
  }
}
