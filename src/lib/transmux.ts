/**
 * TS → fMP4 transmux utility using mux.js.
 *
 * HLS downloads produce video/mp2t (MPEG Transport Stream) blobs from
 * concatenated TS segments. Raw TS can't be played via blob URL in the browser.
 *
 * Primary approach: Feed the entire concatenated blob to mux.js as one
 * continuous TS stream. Data is pushed in 1MB chunks to the SAME Transmuxer
 * instance, with flush() called only once at the end. This eliminates all
 * segment boundary issues — mux.js sees a single continuous stream with no
 * discontinuities, no repeated PAT/PMT, and no GOP alignment boundaries.
 *
 * Output: a single fMP4 blob playable via <video src={blobUrl}> natively.
 */

/** Shape of a mux.js 'data' event payload */
interface TransmuxSegment {
  initSegment: Uint8Array | null;
  data: Uint8Array;
}

/**
 * Transmux an entire concatenated TS blob into a single fMP4 blob.
 *
 * The blob is fed to mux.js in 1MB chunks through a SINGLE Transmuxer
 * instance, with flush() called only at the very end. This streaming approach
 * ensures mux.js sees one continuous TS stream — no segment boundaries, no
 * PAT/PMT duplication, no GOP alignment discontinuities.
 *
 * The resulting fMP4 blob plays natively in <video> via blob URL.
 *
 * @param tsBlob - Concatenated TS blob (type: video/mp2t)
 * @param onProgress - Optional progress callback (0-100)
 * @returns fMP4 Blob ready for native <video> playback
 */
export async function transmuxWholeBlob(
  tsBlob: Blob,
  onProgress?: (percent: number) => void,
): Promise<Blob> {
  const { mp4: muxMp4 } = await import('mux.js');
  const Transmuxer = muxMp4.Transmuxer;

  const transmuxer = new Transmuxer({
    remux: true,
    alignGopsAtEnd: false,
    keepOriginalTimestamps: true,
  });

  let initSegment: Uint8Array | null = null;
  const dataParts: Uint8Array[] = [];

  transmuxer.on('data', (event: TransmuxSegment) => {
    // Capture init segment (ftyp + moov) from first event only
    if (event.initSegment && event.initSegment.byteLength > 0 && !initSegment) {
      initSegment = new Uint8Array(event.initSegment);
    }
    if (event.data && event.data.byteLength > 0) {
      dataParts.push(new Uint8Array(event.data));
    }
  });

  // Swallow non-fatal errors (continuity counter mismatches in TS stream)
  transmuxer.on('error', (_err: unknown) => {
    // Log but don't throw — some TS streams have minor issues that mux.js
    // can recover from. Only throw if no data was produced at all.
  });

  const totalSize = tsBlob.size;
  const CHUNK_SIZE = 1024 * 1024; // 1MB chunks — small enough for smooth processing
  let offset = 0;

  // Stream the blob through mux.js in chunks
  while (offset < totalSize) {
    const end = Math.min(offset + CHUNK_SIZE, totalSize);
    const chunk = await tsBlob.slice(offset, end).arrayBuffer();
    transmuxer.push(new Uint8Array(chunk));
    offset = end;

    if (onProgress) {
      // Report progress: 0-90% for feeding, 90-100% for flush
      onProgress(Math.round((offset / totalSize) * 90));
    }
  }

  // Single flush at the end — mux.js processes remaining data
  transmuxer.flush();
  transmuxer.dispose();

  if (onProgress) onProgress(95);

  if (dataParts.length === 0) {
    throw new Error('Transmux produced no output — source may be corrupted');
  }

  // Assemble: init segment (ftyp+moov) + all moof+mdat fragments
  const outputParts: Uint8Array[] = [];
  if (initSegment) {
    outputParts.push(initSegment);
  }
  outputParts.push(...dataParts);

  if (onProgress) onProgress(100);

  return new Blob(outputParts, { type: 'video/mp4' });
}

/**
 * Transmux a single TS segment into fMP4 data (no init segment).
 * Used by the per-segment transmux path.
 */
async function transmuxSingleSegment(
  tsBuffer: ArrayBuffer,
): Promise<{ initData: Uint8Array | null; dataBytes: Uint8Array } | null> {
  const { mp4: muxMp4 } = await import('mux.js');
  const Transmuxer = muxMp4.Transmuxer;

  return new Promise((resolve) => {
    const transmuxer = new Transmuxer({
      remux: true,
      alignGopsAtEnd: false,
      keepOriginalTimestamps: true,
    });

    let initSeg: Uint8Array | null = null;
    const dataParts: Uint8Array[] = [];

    transmuxer.on('data', (event: TransmuxSegment) => {
      if (event.initSegment && event.initSegment.byteLength > 0 && !initSeg) {
        initSeg = new Uint8Array(event.initSegment);
      }
      if (event.data && event.data.byteLength > 0) {
        dataParts.push(new Uint8Array(event.data));
      }
    });

    transmuxer.on('done', () => {
      // Intentionally empty — we resolve after setTimeout
    });

    // Swallow non-fatal errors
    transmuxer.on('error', () => {});

    try {
      const data = new Uint8Array(tsBuffer);
      transmuxer.push(data);
      transmuxer.flush();
    } catch {
      resolve(null);
      return;
    }

    setTimeout(() => {
      if (dataParts.length === 0) {
        resolve(null);
        return;
      }
      const totalBytes = dataParts.reduce((sum, d) => sum + d.byteLength, 0);
      const dataBytes = new Uint8Array(totalBytes);
      let off = 0;
      for (const d of dataParts) {
        dataBytes.set(d, off);
        off += d.byteLength;
      }
      resolve({ initData: initSeg, dataBytes });
    }, 0);
  });
}

/**
 * Transmux multiple TS segment buffers into a single fMP4 blob (per-segment).
 * Each segment gets its own Transmuxer instance.
 *
 * For HLS downloads, prefer transmuxWholeBlob() which feeds the entire
 * concatenated blob as one continuous stream — better timestamps, no boundaries.
 */
export async function transmuxSegmentsToMp4(
  segmentBuffers: ArrayBuffer[],
  onProgress?: (percent: number) => void,
): Promise<Blob> {
  if (segmentBuffers.length === 0) {
    throw new Error('No segments to transmux');
  }

  const outputParts: Uint8Array[] = [];
  let initSegment: Uint8Array | null = null;
  let processed = 0;

  for (const buffer of segmentBuffers) {
    const result = await transmuxSingleSegment(buffer);

    if (result) {
      if (!initSegment && result.initData) {
        initSegment = result.initData;
        outputParts.push(initSegment);
      }
      if (result.dataBytes.byteLength > 0) {
        outputParts.push(result.dataBytes);
      }
    }

    processed++;
    if (onProgress) {
      onProgress(Math.round((processed / segmentBuffers.length) * 100));
    }
  }

  if (outputParts.length === 0 || (outputParts.length === 1 && !initSegment)) {
    throw new Error('Transmux produced no output — the source segments may be corrupted');
  }

  return new Blob(outputParts, { type: 'video/mp4' });
}
