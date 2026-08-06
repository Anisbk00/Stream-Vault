/**
 * TS → MP4 Remuxer
 *
 * Converts raw MPEG-TS segments to a fragmented MP4 (fMP4) file that browsers
 * can play natively via <video>. This is the same approach used by Netflix,
 * Disney+, and all major streaming platforms for offline playback.
 *
 * Two outputs:
 * 1. Blob — for IndexedDB storage and file saving (backward compatible)
 * 2. Cached segments — init + data segments for direct MSE playback
 *    (skips fMP4 re-parsing, preserves mux.js's video+audio grouping)
 *
 * Implementation uses async/await loop with off() for cleanup.
 * Never uses removeAllListeners() — it doesn't exist on mux.js browser build.
 *
 * IMPORTANT: keepOriginalTimestamps is set to TRUE. When set to false,
 * mux.js recalculates timestamps starting from 0, which can cause it to
 * silently drop segments during discontinuity boundaries or GOP misalignment,
 * resulting in output files that are 30-60% smaller than the input (e.g.,
 * 60MB output from 160MB input — clearly incomplete). Keeping original
 * timestamps preserves all data through the remux pipeline.
 */

import muxjs from 'mux.js';

// ── Segment cache for direct MSE access ─────────────────────────────────────
// After remux, init + data segments are cached here so the player can use
// setupFmp4MseFromSegments() directly (no fMP4 blob re-parsing needed).
// This preserves mux.js's original video+audio grouping per data segment,
// which prevents Chrome's MSE decoder from stalling on timestamp boundaries.

export interface RemuxSegments {
  initSegment: Uint8Array;
  dataSegments: Uint8Array[];
}

const _segmentCache = new Map<string, RemuxSegments>();

export function cacheSegments(taskId: string, segments: RemuxSegments): void {
  _segmentCache.set(taskId, segments);
}

export function getCachedSegments(taskId: string): RemuxSegments | null {
  return _segmentCache.get(taskId) ?? null;
}

export function evictSegments(taskId: string): void {
  _segmentCache.delete(taskId);
}

/**
 * Remux raw TS segment buffers into a single fMP4 blob.
 *
 * Also caches the init + data segments separately for direct MSE playback.
 * Each data segment from mux.js contains BOTH video and audio moof+mdat
 * for that time range — this is critical for Chrome's MSE decoder to
 * process both tracks simultaneously without stalling.
 *
 * @param segmentBuffers - Raw TS segment ArrayBuffers in playlist order
 * @returns fMP4 Blob with type 'video/mp4'
 */
export async function remuxTsToMp4(
  segmentBuffers: ArrayBuffer[],
  taskId?: string,
): Promise<Blob> {
  if (segmentBuffers.length === 0) {
    throw new Error('No segments to remux');
  }

  const totalInputBytes = segmentBuffers.reduce((sum, buf) => sum + buf.byteLength, 0);
  console.log(
    `[SV Remux] Starting TS→MP4 remux: ${segmentBuffers.length} segments, ` +
    `${(totalInputBytes / 1024 / 1024).toFixed(2)} MB total input`,
  );
  const remuxStartTime = performance.now();

  // ── Transmuxer configuration ────────────────────────────────────────────
  // keepOriginalTimestamps: TRUE — Critical for data integrity.
  // When false, mux.js recalculates base_media_decode_time starting from 0,
  // which causes it to silently DROP segments that don't align with its
  // recalculated timeline. This was the root cause of 60MB output from
  // 160MB input — mux.js was discarding ~60% of the video data because
  // timestamp recalculation created discontinuities it couldn't resolve.
  const transmuxer = new muxjs.mp4.Transmuxer({
    remux: true,
    keepOriginalTimestamps: true,
    alignGopsAtEnd: false,
  });

  let initSegment: Uint8Array | null = null;
  const dataParts: Uint8Array[] = [];
  let emptySegmentCount = 0;
  let pushFlushErrorCount = 0;

  const dataHandler = (segment: { initSegment: Uint8Array | null; data: Uint8Array }) => {
    if (segment.initSegment && segment.initSegment.byteLength > 0 && !initSegment) {
      initSegment = new Uint8Array(segment.initSegment);
    }
    if (segment.data && segment.data.byteLength > 0) {
      dataParts.push(new Uint8Array(segment.data));
    } else {
      emptySegmentCount++;
    }
  };

  const errorHandler = (err: Error) => {
    console.warn(`[SV Remux] Non-fatal transmuxer warning: ${err.message}`);
  };

  transmuxer.on('data', dataHandler);
  transmuxer.on('error', errorHandler);

  function processOneSegment(buffer: ArrayBuffer, index: number): Promise<void> {
    return new Promise<void>((resolve, _reject) => {
      let settled = false;

      const doneHandler = () => {
        if (settled) return;
        settled = true;
        transmuxer.off('done', doneHandler);
        resolve();
      };

      transmuxer.on('done', doneHandler);

      try {
        transmuxer.push(new Uint8Array(buffer));
        transmuxer.flush();
      } catch (err) {
        if (!settled) {
          settled = true;
          transmuxer.off('done', doneHandler);
          pushFlushErrorCount++;
          console.warn(
            `[SV Remux] Segment ${index + 1} push/flush error: ` +
            `${err instanceof Error ? err.message : String(err)}`,
          );
          resolve();
        }
      }
    });
  }

  try {
    for (let i = 0; i < segmentBuffers.length; i++) {
      await processOneSegment(segmentBuffers[i], i);

      if ((i + 1) % 50 === 0 || i === segmentBuffers.length - 1) {
        const outputBytes = dataParts.reduce((sum, p) => sum + p.byteLength, 0);
        console.log(
          `[SV Remux] Processed ${i + 1}/${segmentBuffers.length} segments — ` +
          `${(outputBytes / 1024 / 1024).toFixed(2)} MB output, ` +
          `${dataParts.length} fragments, ${emptySegmentCount} empty, ${pushFlushErrorCount} errors`,
        );
      }
    }
  } catch (err) {
    transmuxer.off('data', dataHandler);
    transmuxer.off('error', errorHandler);
    transmuxer.dispose();
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[SV Remux] FAILED: ${msg}`);
    throw new Error(`Remux failed: ${msg}`);
  }

  transmuxer.off('data', dataHandler);
  transmuxer.off('error', errorHandler);
  transmuxer.dispose();

  const elapsed = ((performance.now() - remuxStartTime) / 1000).toFixed(2);

  if (dataParts.length === 0 || !initSegment) {
    console.error(
      `[SV Remux] FAILED — no output after ${segmentBuffers.length} segments ` +
      `(${(totalInputBytes / 1024 / 1024).toFixed(2)} MB) in ${elapsed}s. ` +
      `initSegment=${initSegment ? 'present' : 'MISSING'}, fragments=${dataParts.length}. ` +
      `Empty segments: ${emptySegmentCount}, Push/flush errors: ${pushFlushErrorCount}.`,
    );
    throw new Error(
      'Remux failed — no output produced. The TS data may be corrupted or use an unsupported codec.',
    );
  }

  // ── Output sanity checks ──────────────────────────────────────────────
  const outputBytes = dataParts.reduce((sum, p) => sum + p.byteLength, 0) + (initSegment?.byteLength ?? 0);
  const outputRatio = outputBytes / totalInputBytes;

  // Check 1: Output size vs input size.
  // A valid TS→fMP4 remux typically produces output that is 80-100% of the
  // input size (TS has ~2-4% overhead per packet, fMP4 is more efficient).
  // If the output is less than 50%, mux.js is silently dropping significant
  // data — the resulting file will be unplayable or have huge gaps.
  // Previous threshold of 10% was too lenient: a 60MB output from 160MB
  // input (37.5%) passed the check but produced a broken file.
  if (outputRatio < 0.5 && totalInputBytes > 500_000) {
    console.error(
      `[SV Remux] FAILED — output is suspiciously small: ` +
      `${(outputBytes / 1024 / 1024).toFixed(2)} MB output vs ${(totalInputBytes / 1024 / 1024).toFixed(2)} MB input ` +
      `(${(outputRatio * 100).toFixed(1)}%). mux.js is dropping too much data. ` +
      `Empty segments: ${emptySegmentCount}/${segmentBuffers.length}, Push/flush errors: ${pushFlushErrorCount}.`,
    );
    throw new Error(
      `Remux failed — output is only ${(outputRatio * 100).toFixed(1)}% of input size. ` +
      `mux.js is silently dropping video data during timestamp recalculation. ` +
      `Input: ${(totalInputBytes / 1024 / 1024).toFixed(2)} MB → Output: ${(outputBytes / 1024 / 1024).toFixed(2)} MB. ` +
      `The download will fall back to raw TS playback.`,
    );
  }

  // Check 2: Warn if output ratio is suspiciously low but above the hard threshold.
  // 50-70% ratio is unusual — might indicate partial data loss.
  if (outputRatio < 0.7 && totalInputBytes > 1_000_000) {
    console.warn(
      `[SV Remux] ⚠️ Output ratio is ${(outputRatio * 100).toFixed(1)}% — ` +
      `expected 80-100% for a clean remux. The video may have gaps. ` +
      `Empty segments: ${emptySegmentCount}/${segmentBuffers.length}, ` +
      `Push/flush errors: ${pushFlushErrorCount}.`,
    );
  }

  // Check 3: Too many empty segments means mux.js couldn't parse much of the input.
  const emptyRatio = emptySegmentCount / segmentBuffers.length;
  if (emptyRatio > 0.3 && segmentBuffers.length > 5) {
    console.error(
      `[SV Remux] FAILED — ${emptySegmentCount}/${segmentBuffers.length} segments ` +
      `(${(emptyRatio * 100).toFixed(1)}%) produced empty output. ` +
      `The TS data is likely in a format mux.js can't parse. ` +
      `Push/flush errors: ${pushFlushErrorCount}.`,
    );
    throw new Error(
      `Remux failed — ${(emptyRatio * 100).toFixed(1)}% of segments produced no output. ` +
      `The TS data uses codecs or a format that mux.js doesn't support. ` +
      `The download will fall back to raw TS playback.`,
    );
  }

  // Validate the init segment starts with ftyp box (valid fMP4 structure)
  if (initSegment.byteLength >= 8) {
    const view = new DataView(initSegment.buffer as ArrayBuffer, initSegment.byteOffset, 8);
    const boxType = view.getUint32(4);
    // ftyp = 0x66747970
    if (boxType !== 0x66747970) {
      console.error(
        `[SV Remux] FAILED — init segment doesn't start with ftyp box. ` +
        `Got: 0x${boxType.toString(16)}. Invalid fMP4 structure.`,
      );
      throw new Error(
        'Remux failed — invalid fMP4 structure (no ftyp box). The TS data may be corrupted.',
      );
    }
  }

  // Cache segments for direct MSE playback (skip fMP4 re-parsing)
  if (taskId) {
    cacheSegments(taskId, {
      initSegment,
      dataSegments: [...dataParts],
    });
  }

  // Assemble blob: init segment (ftyp+moov) + all moof+mdat fragments
  const outputParts: Uint8Array[] = [initSegment, ...dataParts];
  const outputBlob = new Blob(outputParts, { type: 'video/mp4' });

  console.log(
    `[SV Remux] SUCCESS — ${segmentBuffers.length} segments → ${dataParts.length} fMP4 fragments in ${elapsed}s. ` +
    `Input: ${(totalInputBytes / 1024 / 1024).toFixed(2)} MB → Output: ${(outputBlob.size / 1024 / 1024).toFixed(2)} MB ` +
    `(${(outputRatio * 100).toFixed(1)}%). Empty: ${emptySegmentCount}, Errors: ${pushFlushErrorCount}.`,
  );

  return outputBlob;
}
