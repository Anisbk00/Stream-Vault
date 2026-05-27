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

  const transmuxer = new muxjs.mp4.Transmuxer({
    remux: true,
    keepOriginalTimestamps: false,
    alignGopsAtEnd: false,
  });

  let initSegment: Uint8Array | null = null;
  const dataParts: Uint8Array[] = [];
  let emptySegmentCount = 0;

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
          `${dataParts.length} fragments`,
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
      `initSegment=${initSegment ? 'present' : 'MISSING'}, fragments=${dataParts.length}.`,
    );
    throw new Error(
      'Remux failed — no output produced. The TS data may be corrupted or use an unsupported codec.',
    );
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
    `Input: ${(totalInputBytes / 1024 / 1024).toFixed(2)} MB → Output: ${(outputBlob.size / 1024 / 1024).toFixed(2)} MB. ` +
    `Empty segments: ${emptySegmentCount}.`,
  );

  return outputBlob;
}
