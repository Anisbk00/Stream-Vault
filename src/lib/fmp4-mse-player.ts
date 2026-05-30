/**
 * fMP4 → MSE Player
 *
 * Plays fragmented MP4 blobs using MediaSource Extensions (MSE) instead of
 * blob URLs. Chrome's blob URL handler for <video> stalls on large fMP4 files
 * because it can't seek/decode efficiently through fragmented boxes. MSE gives
 * the browser explicit control over buffering and seeking, which is exactly how
 * Netflix, YouTube, and all professional web video players handle playback.
 *
 * Why not blob URL?
 * - Chrome's <video src=blobUrl> stalls at ~50s even with full data buffered
 * - The blob URL handler doesn't support efficient random access for fMP4
 * - MSE appends data in controlled fragments with proper timing metadata
 * - MSE is the production-standard approach for web video playback
 *
 * Entry points:
 * 1. setupFmp4MseProgressive(video, initSegment, dataSegments) — RECOMMENDED
 *    Progressive appending with buffer eviction. Avoids QuotaExceededError
 *    on large files by only keeping ~60s ahead and evicting behind playback.
 *
 * 2. setupFmp4MseFromSegments(video, initSegment, dataSegments) — DEPRECATED
 *    Appends all data at once. Fails with QuotaExceededError on large files.
 *
 * 3. setupFmp4Mse(video, blob) — DEPRECATED
 *    Parses fMP4 blob, then appends all at once. Same quota issue.
 */

// ── Progressive MSE Handle ──────────────────────────────────────────────────

export interface ProgressiveMseHandle {
  mediaSource: MediaSource;
  objectUrl: string;
  /** Total number of data segments to append */
  readonly totalSegments: number;
  /** Number of segments already appended to SourceBuffer */
  readonly appendedCount: number;
  /** Whether all segments have been appended and endOfStream() called */
  readonly isComplete: boolean;
  /** Append the next N data segments. Returns actual count appended. */
  appendNext: (count: number) => Promise<number>;
  /** Evict buffer data before the given time (seconds) to free SourceBuffer quota */
  evictBefore: (timeSec: number) => Promise<void>;
  /** Get seconds of buffered data ahead of the given time */
  getBufferedAhead: (currentTimeSec: number) => number;
  /** Get seconds of buffered data behind the given time */
  getBufferedBehind: (currentTimeSec: number) => number;
  /** Destroy MediaSource and revoke object URL */
  cleanup: () => void;
}

// ── Legacy Handle ───────────────────────────────────────────────────────────

export interface MsePlaybackHandle {
  mediaSource: MediaSource;
  objectUrl: string;
  cleanup: () => void;
}

// ── Progressive MSE Setup ───────────────────────────────────────────────────

/**
 * Set up progressive MSE-based fMP4 playback with buffer eviction.
 *
 * Instead of appending all segments at once (which causes QuotaExceededError
 * on large files), this approach:
 * 1. Appends init segment + initial batch (~60s of video)
 * 2. Returns a handle with appendNext/evictBefore methods
 * 3. The caller (VideoPlayer) drives progressive appending via timeupdate
 * 4. Old buffer ranges are evicted as playback advances to free quota
 *
 * This is exactly how Netflix/YouTube handle MSE playback — they never
 * buffer the entire video at once.
 */
export async function setupFmp4MseProgressive(
  video: HTMLVideoElement,
  initSegment: Uint8Array,
  dataSegments: Uint8Array[],
  options?: {
    /** Number of segments to append initially (default: 6 ≈ 60s) */
    initialBatchSize?: number;
  },
): Promise<ProgressiveMseHandle> {
  if (!initSegment || initSegment.byteLength === 0) {
    throw new Error('MSE setup failed — no init segment');
  }
  if (dataSegments.length === 0) {
    throw new Error('MSE setup failed — no data segments');
  }

  const initialBatch = options?.initialBatchSize ?? 6;

  const codecs = detectCodecs(initSegment);
  const mimeType = `video/mp4; codecs="${codecs}"`;
  const finalMimeType = MediaSource.isTypeSupported(mimeType) ? mimeType : 'video/mp4';

  const mediaSource = new MediaSource();
  const objectUrl = URL.createObjectURL(mediaSource);

  let sourceBuffer!: SourceBuffer;
  let appendedCount = 0;
  let isComplete = false;
  let isUpdating = false;
  let destroyed = false;

  const readyPromise = new Promise<void>((resolve, reject) => {
    mediaSource.addEventListener('sourceopen', async () => {
      try {
        sourceBuffer = mediaSource.addSourceBuffer(finalMimeType);
        sourceBuffer.mode = 'segments';

        // Append init segment
        await appendBuffer(sourceBuffer, initSegment);

        // Append initial batch
        const batchSize = Math.min(initialBatch, dataSegments.length);
        for (let i = 0; i < batchSize; i++) {
          await appendBuffer(sourceBuffer, dataSegments[i]);
          appendedCount++;
        }

        // If all segments fit in initial batch, end the stream immediately
        if (appendedCount >= dataSegments.length) {
          if (mediaSource.readyState === 'open') {
            mediaSource.endOfStream();
          }
          isComplete = true;
        }

        console.log(
          `[SV MSE] Progressive: init + ${appendedCount}/${dataSegments.length} segments appended` +
          (isComplete ? ' (complete)' : ''),
        );

        resolve();
      } catch (err) {
        console.error(`[SV MSE] Progressive setup failed:`, err);
        reject(err);
      }
    }, { once: true });
  });

  video.src = objectUrl;
  await readyPromise;

  // ── appendNext ──────────────────────────────────────────────────────────

  const appendNext = async (count: number): Promise<number> => {
    if (isUpdating || isComplete || destroyed) return 0;
    isUpdating = true;

    try {
      let appended = 0;
      const startIdx = appendedCount;
      const endIdx = Math.min(startIdx + count, dataSegments.length);

      for (let i = startIdx; i < endIdx; i++) {
        if (destroyed) break;
        try {
          await appendBuffer(sourceBuffer, dataSegments[i]);
          appendedCount++;
          appended++;
        } catch (err) {
          if (err instanceof DOMException && err.name === 'QuotaExceededError') {
            console.warn(
              `[SV MSE] Progressive: quota exceeded at segment ${appendedCount}/${dataSegments.length}. ` +
              `Call evictBefore() to free space, then appendNext() again.`,
            );
            // Stop appending — caller should evict and retry
            break;
          }
          throw err;
        }
      }

      // All segments appended — finalize
      if (appendedCount >= dataSegments.length && !isComplete && !destroyed) {
        if (mediaSource.readyState === 'open') {
          mediaSource.endOfStream();
        }
        isComplete = true;
        console.log(`[SV MSE] Progressive: all ${dataSegments.length} segments appended — complete`);
      }

      return appended;
    } finally {
      isUpdating = false;
    }
  };

  // ── evictBefore ─────────────────────────────────────────────────────────

  const evictBefore = async (timeSec: number): Promise<void> => {
    if (isUpdating || destroyed) return;
    if (timeSec <= 0) return;

    // Check if there's data to evict
    const buffered = sourceBuffer.buffered;
    if (buffered.length === 0) return;

    const bufferStart = buffered.start(0);
    // Evict up to (timeSec - 10s safety margin) to avoid evicting data
    // the decoder still needs for reference frames
    const evictEnd = Math.max(0, timeSec - 10);
    if (evictEnd <= bufferStart) return; // nothing to evict

    isUpdating = true;
    try {
      await removeRange(sourceBuffer, bufferStart, evictEnd);
      console.log(
        `[SV MSE] Progressive: evicted [${bufferStart.toFixed(1)}s, ${evictEnd.toFixed(1)}s] ` +
        `— freed buffer behind playback`,
      );
    } catch (err) {
      // Eviction failure is non-critical — video continues playing
      console.warn(`[SV MSE] Progressive: eviction failed:`, err);
    } finally {
      isUpdating = false;
    }
  };

  // ── Buffered queries ────────────────────────────────────────────────────

  const getBufferedAhead = (currentTimeSec: number): number => {
    const buffered = video.buffered;
    if (buffered.length === 0) return 0;
    for (let i = 0; i < buffered.length; i++) {
      if (currentTimeSec >= buffered.start(i) && currentTimeSec <= buffered.end(i)) {
        return buffered.end(i) - currentTimeSec;
      }
    }
    // Current time is in a gap between buffered ranges
    return 0;
  };

  const getBufferedBehind = (currentTimeSec: number): number => {
    const buffered = video.buffered;
    if (buffered.length === 0) return 0;
    for (let i = 0; i < buffered.length; i++) {
      if (currentTimeSec >= buffered.start(i) && currentTimeSec <= buffered.end(i)) {
        return currentTimeSec - buffered.start(i);
      }
    }
    return 0;
  };

  // ── Cleanup ─────────────────────────────────────────────────────────────

  const cleanup = () => {
    destroyed = true;
    try {
      if (mediaSource.readyState === 'open') mediaSource.endOfStream();
    } catch { /* already closed */ }
    URL.revokeObjectURL(objectUrl);
  };

  return {
    mediaSource,
    objectUrl,
    get totalSegments() { return dataSegments.length; },
    get appendedCount() { return appendedCount; },
    get isComplete() { return isComplete; },
    appendNext,
    evictBefore,
    getBufferedAhead,
    getBufferedBehind,
    cleanup,
  };
}

// ── Legacy: Set up MSE from pre-separated segments (appends ALL at once) ────

/**
 * @deprecated Use setupFmp4MseProgressive instead.
 * Appends all data at once — causes QuotaExceededError on large files.
 */
export async function setupFmp4MseFromSegments(
  video: HTMLVideoElement,
  initSegment: Uint8Array,
  dataSegments: Uint8Array[],
): Promise<MsePlaybackHandle> {
  if (!initSegment || initSegment.byteLength === 0) {
    throw new Error('MSE setup failed — no init segment');
  }
  if (dataSegments.length === 0) {
    throw new Error('MSE setup failed — no data segments');
  }

  const codecs = detectCodecs(initSegment);
  const mimeType = `video/mp4; codecs="${codecs}"`;

  const finalMimeType = MediaSource.isTypeSupported(mimeType) ? mimeType : 'video/mp4';

  console.log(
    `[SV MSE] Direct segments: init=${initSegment.byteLength} bytes, ` +
    `${dataSegments.length} segments, MIME=${finalMimeType}`,
  );

  const mediaSource = new MediaSource();
  const objectUrl = URL.createObjectURL(mediaSource);

  const readyPromise = new Promise<void>((resolve, reject) => {
    mediaSource.addEventListener('sourceopen', async () => {
      try {
        const sb = mediaSource.addSourceBuffer(finalMimeType);
        sb.mode = 'segments';

        await appendBuffer(sb, initSegment);

        for (let i = 0; i < dataSegments.length; i++) {
          await appendBuffer(sb, dataSegments[i]);
          if ((i + 1) % 20 === 0 || i === dataSegments.length - 1) {
            console.log(`[SV MSE] Appended segment ${i + 1}/${dataSegments.length}`);
          }
        }

        if (mediaSource.readyState === 'open') {
          mediaSource.endOfStream();
        }

        console.log(`[SV MSE] All segments appended — ready for playback`);
        resolve();
      } catch (err) {
        console.error(`[SV MSE] Setup failed:`, err);
        reject(err);
      }
    }, { once: true });
  });

  video.src = objectUrl;
  await readyPromise;

  return {
    mediaSource,
    objectUrl,
    cleanup: () => {
      try {
        if (mediaSource.readyState === 'open') mediaSource.endOfStream();
      } catch { /* already closed */ }
      URL.revokeObjectURL(objectUrl);
    },
  };
}

// ── Legacy: Set up MSE from blob (parses + appends ALL at once) ─────────────

/**
 * @deprecated Use setupFmp4MseProgressive instead.
 * Parses fMP4 blob and appends all at once — causes QuotaExceededError on large files.
 */
export async function setupFmp4Mse(
  video: HTMLVideoElement,
  blob: Blob,
): Promise<MsePlaybackHandle> {
  const arrayBuffer = await blob.arrayBuffer();
  const data = new Uint8Array(arrayBuffer);

  const { initSegment, fragments } = parseFmp4Fragments(data);

  if (!initSegment || initSegment.byteLength === 0) {
    throw new Error('fMP4 parsing failed — no init segment found');
  }

  // Combine consecutive fragment pairs (video+audio from same segment).
  // mux.js produces 2 moof+mdat per flush: one video, one audio.
  // They MUST be appended together to prevent Chrome decoder stalls.
  const combinedFragments = combineFragmentPairs(fragments);

  console.log(
    `[SV MSE] Parsed fMP4: init=${initSegment.byteLength} bytes, ` +
    `${fragments.length} raw fragments → ${combinedFragments.length} combined, ` +
    `total=${data.byteLength} bytes`,
  );

  const codecs = detectCodecs(initSegment);
  const mimeType = `video/mp4; codecs="${codecs}"`;

  const finalMimeType = MediaSource.isTypeSupported(mimeType) ? mimeType : 'video/mp4';

  const mediaSource = new MediaSource();
  const objectUrl = URL.createObjectURL(mediaSource);

  const readyPromise = new Promise<void>((resolve, reject) => {
    mediaSource.addEventListener('sourceopen', async () => {
      try {
        const sb = mediaSource.addSourceBuffer(finalMimeType);
        sb.mode = 'segments';

        await appendBuffer(sb, initSegment);

        for (let i = 0; i < combinedFragments.length; i++) {
          await appendBuffer(sb, combinedFragments[i]);
          if ((i + 1) % 20 === 0 || i === combinedFragments.length - 1) {
            console.log(
              `[SV MSE] Appended fragment ${i + 1}/${combinedFragments.length}`,
            );
          }
        }

        if (mediaSource.readyState === 'open') {
          mediaSource.endOfStream();
        }

        console.log(`[SV MSE] All data appended — ready for playback`);
        resolve();
      } catch (err) {
        console.error(`[SV MSE] Setup failed:`, err);
        reject(err);
      }
    }, { once: true });
  });

  video.src = objectUrl;
  await readyPromise;

  return {
    mediaSource,
    objectUrl,
    cleanup: () => {
      try {
        if (mediaSource.readyState === 'open') mediaSource.endOfStream();
      } catch { /* already closed */ }
      URL.revokeObjectURL(objectUrl);
    },
  };
}

// ── Fragment Grouping ──────────────────────────────────────────────────

/**
 * Group fMP4 fragments by their moof sequence number.
 *
 * mux.js's Transmuxer produces 2 moof+mdat pairs per segment flush:
 * one for video and one for audio. Both share the same mfhd sequence_number.
 * When these are appended separately to a single SourceBuffer, Chrome's
 * decoder can stall because it receives video data without the corresponding
 * audio (or vice versa).
 *
 * By grouping fragments with the same sequence number into a single
 * appendBuffer call, Chrome processes both tracks for a time range
 * simultaneously — no stalls.
 *
 * This replaces the old combineFragmentPairs() which blindly paired
 * consecutive fragments (i, i+1). That broke when a segment produced
 * only 1 or 3+ moofs, shifting all subsequent pairings.
 */
export function combineFragmentPairs(fragments: Uint8Array[]): Uint8Array[] {
  if (fragments.length <= 1) return fragments;

  // Read mfhd sequence_number from each moof to group correctly.
  // moof box structure: [size(4)][type'moof'(4)][mfhd: size(4)+type(4)+version+flags(4)+sequence_number(4)]
  // So sequence_number is at offset 8+8+4 = 20 from the start of the moof box.
  // But the fragment starts at the moof box, so offset 16 within the fragment
  // (after moof.size(4) + moof.type(4) + mfhd.size(4) + mfhd.type(4) + version_flags(4) = 20 bytes,
  //  sequence_number is at byte 16 if we count from 0: 4+4+4+4 = 16)
  //
  // Actually: moof[4 size][4 'moof']mfhd[4 size][4 'mfhd'][4 version/flags][4 sequence_number]
  // sequence_number offset from fragment start = 4+4+4+4+4 = 20

  const groups = new Map<number, Uint8Array[]>();
  const groupOrder: number[] = [];

  for (const frag of fragments) {
    const seqNum = readMfhdSequenceNumber(frag);
    if (seqNum !== null) {
      if (!groups.has(seqNum)) {
        groups.set(seqNum, []);
        groupOrder.push(seqNum);
      }
      groups.get(seqNum)!.push(frag);
    } else {
      // Can't read sequence number — treat as its own group (odd fragment out)
      const fallbackKey = -1 - groupOrder.length;
      groups.set(fallbackKey, [frag]);
      groupOrder.push(fallbackKey);
    }
  }

  const combined: Uint8Array[] = [];
  for (const seqNum of groupOrder) {
    const group = groups.get(seqNum)!;
    if (group.length === 1) {
      combined.push(group[0]);
    } else {
      const totalLen = group.reduce((sum, buf) => sum + buf.byteLength, 0);
      const merged = new Uint8Array(totalLen);
      let offset = 0;
      for (const buf of group) {
        merged.set(buf, offset);
        offset += buf.byteLength;
      }
      combined.push(merged);
    }
  }

  return combined;
}

/**
 * Read the mfhd sequence_number from a moof+mdat fragment.
 * Returns null if the fragment doesn't start with a moof box or
 * the mfhd box can't be found.
 */
function readMfhdSequenceNumber(fragment: Uint8Array): number | null {
  // Fragment must start with a moof box
  if (fragment.byteLength < 24) return null;
  const boxType = readBoxType(fragment, 4);
  if (boxType !== 'moof') return null;

  // moov/moof box layout: [size(4)][type(4)][child boxes...]
  // First child should be mfhd: [size(4)][type'mfhd'(4)][version+flags(4)][sequence_number(4)]
  // Offset from fragment start: 8 (moof header) + 4 (mfhd size) + 4 (mfhd type) + 4 (version/flags) = 20

  const moofSize = readUint32(fragment, 0);
  if (moofSize < 24) return null;

  // Verify the child box is mfhd
  const childType = readBoxType(fragment, 12); // 8 (moof header) + 4 (child size)
  if (childType !== 'mfhd') return null;

  // Read sequence number at offset 20
  return readUint32(fragment, 20);
}

// ── SourceBuffer Helpers ────────────────────────────────────────────────────

function appendBuffer(sb: SourceBuffer, data: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    const doAppend = () => {
      const onUpdateEnd = () => {
        sb.removeEventListener('updateend', onUpdateEnd);
        sb.removeEventListener('error', onError);
        resolve();
      };
      const onError = () => {
        sb.removeEventListener('updateend', onUpdateEnd);
        sb.removeEventListener('error', onError);
        reject(new Error('SourceBuffer append error'));
      };
      sb.addEventListener('updateend', onUpdateEnd);
      sb.addEventListener('error', onError);
      sb.appendBuffer(data.buffer as ArrayBuffer);
    };

    if (sb.updating) {
      const waitAndUpdate = () => {
        sb.removeEventListener('updateend', waitAndUpdate);
        doAppend();
      };
      sb.addEventListener('updateend', waitAndUpdate);
    } else {
      doAppend();
    }
  });
}

function removeRange(sb: SourceBuffer, start: number, end: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const doRemove = () => {
      const onUpdateEnd = () => {
        sb.removeEventListener('updateend', onUpdateEnd);
        sb.removeEventListener('error', onError);
        resolve();
      };
      const onError = () => {
        sb.removeEventListener('updateend', onUpdateEnd);
        sb.removeEventListener('error', onError);
        reject(new Error('SourceBuffer remove error'));
      };
      sb.addEventListener('updateend', onUpdateEnd);
      sb.addEventListener('error', onError);
      sb.remove(start, end);
    };

    if (sb.updating) {
      const waitAndRemove = () => {
        sb.removeEventListener('updateend', waitAndRemove);
        doRemove();
      };
      sb.addEventListener('updateend', waitAndRemove);
    } else {
      doRemove();
    }
  });
}

// ── fMP4 Box Parsing ─────────────────────────────────────────────────────────

interface Fmp4ParseResult {
  initSegment: Uint8Array;
  fragments: Uint8Array[];
}

export function parseFmp4Fragments(data: Uint8Array): Fmp4ParseResult {
  let offset = 0;
  let initEnd = 0;
  const fragments: Uint8Array[] = [];
  let currentFragmentStart = -1;

  while (offset + 8 <= data.length) {
    const boxSize = readUint32(data, offset);
    const boxType = readBoxType(data, offset + 4);
    const effectiveSize = boxSize === 0 ? data.length - offset : boxSize;

    if (boxType === 'ftyp' || boxType === 'moov' || boxType === 'mvhd' ||
        boxType === 'trak' || boxType === 'mdia' || boxType === 'minf' ||
        boxType === 'stbl' || boxType === 'dinf' || boxType === 'udta') {
      offset += effectiveSize;
      initEnd = offset;
    } else if (boxType === 'moof') {
      if (currentFragmentStart >= 0) {
        fragments.push(data.slice(currentFragmentStart, offset));
      }
      currentFragmentStart = offset;
      offset += effectiveSize;
    } else if (boxType === 'mdat') {
      offset += effectiveSize;
    } else {
      offset += effectiveSize;
    }

    if (effectiveSize === 0) break;
  }

  if (currentFragmentStart >= 0) {
    fragments.push(data.slice(currentFragmentStart));
  }

  return {
    initSegment: data.slice(0, initEnd),
    fragments,
  };
}

function readUint32(data: Uint8Array, offset: number): number {
  return (
    (data[offset] << 24) |
    (data[offset + 1] << 16) |
    (data[offset + 2] << 8) |
    data[offset + 3]
  ) >>> 0;
}

function readBoxType(data: Uint8Array, offset: number): string {
  return String.fromCharCode(
    data[offset],
    data[offset + 1],
    data[offset + 2],
    data[offset + 3],
  );
}

// ── Codec Detection ──────────────────────────────────────────────────────────

function detectCodecs(initSegment: Uint8Array): string {
  const codecs: string[] = [];

  const moovOffset = findBox(initSegment, 0, initSegment.byteLength, 'moov');
  if (moovOffset < 0) return 'avc1.64001f,mp4a.40.2';

  const moovSize = readUint32(initSegment, moovOffset);
  const moovEnd = moovOffset + moovSize;
  let pos = moovOffset + 8;

  while (pos + 8 <= moovEnd) {
    const trakSize = readUint32(initSegment, pos);
    const trakType = readBoxType(initSegment, pos + 4);

    if (trakType === 'trak' && trakSize > 0) {
      const trakEnd = pos + trakSize;
      const hdlrOffset = findBox(initSegment, pos, trakEnd, 'hdlr');
      if (hdlrOffset >= 0) {
        const handlerType = readBoxType(initSegment, hdlrOffset + 8 + 8);
        const isVideo = handlerType === 'vide';
        const isAudio = handlerType === 'soun';

        if (isVideo) {
          const stsdOffset = findBox(initSegment, pos, trakEnd, 'stsd');
          if (stsdOffset >= 0) {
            const videoCodec = parseVideoCodecFromStsd(initSegment, stsdOffset);
            if (videoCodec) codecs.push(videoCodec);
          }
        } else if (isAudio) {
          const stsdOffset = findBox(initSegment, pos, trakEnd, 'stsd');
          if (stsdOffset >= 0) {
            const audioCodec = parseAudioCodecFromStsd(initSegment, stsdOffset);
            if (audioCodec) codecs.push(audioCodec);
          }
        }
      }
    }

    pos += trakSize > 0 ? trakSize : 8;
  }

  return codecs.length > 0 ? codecs.join(',') : 'avc1.64001f,mp4a.40.2';
}

function findBox(data: Uint8Array, start: number, end: number, type: string): number {
  let pos = start;
  while (pos + 8 <= end) {
    const boxSize = readUint32(data, pos);
    const boxType = readBoxType(data, pos + 4);
    if (boxType === type) return pos;
    if (boxSize === 0) break;
    pos += boxSize;
  }
  return -1;
}

function parseVideoCodecFromStsd(data: Uint8Array, stsdOffset: number): string | null {
  const entryStart = stsdOffset + 8 + 4 + 4;
  let pos = entryStart;

  while (pos + 8 < data.length) {
    const entrySize = readUint32(data, pos);
    const entryType = readBoxType(data, pos + 4);

    if (entryType === 'avc1' || entryType === 'avc3') {
      const avcCOffset = findBox(data, pos, pos + entrySize, 'avcC');
      if (avcCOffset >= 0) {
        const profile = data[avcCOffset + 8 + 1];
        const compat = data[avcCOffset + 8 + 2];
        const level = data[avcCOffset + 8 + 3];
        return `avc1.${toHex(profile)}${toHex(compat)}${toHex(level)}`;
      }
      return 'avc1.64001f';
    }

    if (entrySize === 0) break;
    pos += entrySize;
  }

  return null;
}

function parseAudioCodecFromStsd(data: Uint8Array, stsdOffset: number): string | null {
  const entryStart = stsdOffset + 8 + 4 + 4;
  let pos = entryStart;

  while (pos + 8 < data.length) {
    const entrySize = readUint32(data, pos);
    const entryType = readBoxType(data, pos + 4);

    if (entryType === 'mp4a') {
      return 'mp4a.40.2';
    }

    if (entrySize === 0) break;
    pos += entrySize;
  }

  return null;
}

function toHex(n: number): string {
  return n.toString(16).padStart(2, '0').toLowerCase();
}
