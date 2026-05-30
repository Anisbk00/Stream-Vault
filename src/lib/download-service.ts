// Centralized Download Manager
// Downloads survive page navigation, component unmounts, and tab switches.
// AbortControllers are stored at module level (not React refs).
// Zustand store is accessed via getState() — works outside React components.
//
// QUEUE: Downloads are processed one at a time (FIFO — first in, first downloaded).
// When a download is requested, a task is created immediately (status: 'pending')
// and added to the queue. The queue processor runs downloads sequentially to avoid
// overwhelming the Vercel proxy with concurrent requests.

import type { DownloadTask, DownloadResult, SubtitleTrackInfo } from './hls-downloader';
import { startDownload as startHlsDownload } from './hls-downloader';
import { saveBlob as saveBlobToStorage, saveSubtitle as saveSubtitleToStorage, deleteBlob as deleteBlobFromStorage, savePoster as savePosterToStorage } from './download-storage';

// ── In-memory blob cache (module-level, survives navigation) ─────────────
// Blobs are NOT stored in Zustand because React 19's concurrent rendering
// uses structuredClone on state, which fails with large Blobs ("Share too large").
// This Map holds the blob references for immediate playback after download.
// Blobs are evicted on task removal or when the player closes.
const _blobCache = new Map<string, Blob>();

/** Store a blob in memory for immediate playback (bypasses Zustand) */
export function cacheBlob(taskId: string, blob: Blob): void {
  _blobCache.set(taskId, blob);
}

/** Retrieve a cached blob (returns null if not in memory) */
export function getCachedBlob(taskId: string): Blob | null {
  return _blobCache.get(taskId) ?? null;
}

/** Remove a cached blob (frees memory) */
export function evictBlob(taskId: string): void {
  _blobCache.delete(taskId);
}
import { fetchStreamSources } from '@/services/api';
import { useDownloadStore } from '@/store';
import { toast } from 'sonner';
// Transmux removed — raw TS segments are played via fake m3u8 + HLS.js.
// HLS.js natively demuxes TS segments with correct timestamp alignment,
// unlike mux.js which produced fMP4 with broken video decode times.

const PROXY_BASE = '/api/stream/proxy';

function proxyUrl(targetUrl: string, referer?: string): string {
  let url = `${PROXY_BASE}?url=${encodeURIComponent(targetUrl)}`;
  if (referer) url += `&referer=${encodeURIComponent(referer)}`;
  return url;
}

/**
 * Fetch an m3u8 manifest with smart fallback:
 * 1. Try direct browser fetch first — some CDNs allow CORS from browsers
 *    but block server-side proxies (datacenter IPs like Vercel's).
 * 2. Fall back to our server-side proxy if direct fetch fails (CORS, 403, etc.)
 *
 * Returns the response text if successful, or null if both attempts fail.
 */
async function fetchM3u8WithFallback(url: string, referer?: string, timeout = 12000): Promise<{ text: string; usedProxy: boolean } | null> {
  // ── Attempt 1: Direct browser fetch ──────────────────────────────
  // Many HLS CDNs set Access-Control-Allow-Origin: * for m3u8 manifests
  // because web players (Video.js, HLS.js) fetch them via XHR/fetch.
  // Even when CORS blocks reading the body, some CDNs allow it.
  // More importantly, the request uses the USER'S IP (not Vercel's),
  // which CDNs typically allow.
  try {
    const directHeaders: Record<string, string> = {
      'Accept': 'application/vnd.apple.mpegurl, application/x-mpegurl, */*',
    };
    // Set Referer if we have one (helps CDN hotlink checks)
    if (referer) directHeaders['Referer'] = referer;

    const directResp = await fetch(url, {
      signal: AbortSignal.timeout(timeout),
      headers: directHeaders,
      mode: 'cors',
    });
    if (directResp.ok) {
      const text = await directResp.text();
      if (text.includes('#EXT')) {
        console.log(
          `[SV DownloadService] Direct browser fetch SUCCEEDED for m3u8 ` +
          `(bypassed proxy — user IP accepted by CDN): ${url.substring(0, 80)}...`
        );
        return { text, usedProxy: false };
      }
    }
    console.log(
      `[SV DownloadService] Direct fetch got ${directResp.status} for m3u8, falling back to proxy: ${url.substring(0, 60)}...`
    );
  } catch (directErr) {
    // CORS error, network error, timeout — fall through to proxy
    const msg = directErr instanceof Error ? directErr.message : String(directErr);
    console.log(
      `[SV DownloadService] Direct browser fetch failed (${msg.substring(0, 50)}), falling back to proxy: ${url.substring(0, 60)}...`
    );
  }

  // ── Attempt 2: Server-side proxy ──────────────────────────────
  try {
    const proxyResp = await fetch(proxyUrl(url, referer), { signal: AbortSignal.timeout(timeout) });
    if (proxyResp.ok) {
      const text = await proxyResp.text();
      if (text.includes('#EXT')) {
        return { text, usedProxy: true };
      }
    }
    console.warn(
      `[SV DownloadService] Proxy fetch also FAILED for m3u8: ${proxyResp.status} ${proxyResp.statusText}, ` +
      `url='${url.substring(0, 80)}...'`
    );
  } catch (proxyErr) {
    console.warn(
      `[SV DownloadService] Proxy fetch error for m3u8: ` +
      `${proxyErr instanceof Error ? proxyErr.message : String(proxyErr)}`
    );
  }

  return null; // Both attempts failed
}

// ── URL resolution helper for source probing ──────────────────────────────
function resolveProbeUrl(base: string, relative: string): string {
  if (relative.startsWith('http')) return relative;
  try {
    return new URL(relative, base).href;
  } catch {
    return base.substring(0, base.lastIndexOf('/') + 1) + relative;
  }
}

// ── HLS Source Quality Probing ─────────────────────────────────────────────
// Before downloading, probe each HLS source's master playlist to find the
// one with the highest maximum bandwidth variant. This ensures we always
// download the best quality stream, even when the API returns multiple
// sources with unknown ('auto') quality labels.

interface ProbedSource {
  url: string;
  quality: string;
  provider: string;
  maxBandwidth: number;
  bestResolution: string;
}

async function probeHlsSource(source: { url: string; quality: string; provider: string }, referer?: string): Promise<ProbedSource> {
  const result: ProbedSource = {
    url: source.url,
    quality: source.quality,
    provider: source.provider,
    maxBandwidth: 0,
    bestResolution: '',
  };

  try {
    // Try direct browser fetch first (user's IP), then proxy fallback (Vercel's IP)
    const m3u8Result = await fetchM3u8WithFallback(source.url, referer, 12000);
    if (!m3u8Result) {
      console.warn(
        `[SV DownloadService] Probe FAILED for ${source.provider} source: both direct and proxy fetch failed, ` +
        `url='${source.url.substring(0, 80)}...'`
      );
      return result;
    }

    const text = m3u8Result.text;
    if (!text.includes('#EXT')) return result; // Not a valid m3u8

    const isMaster = text.includes('#EXT-X-STREAM-INF');
    if (!isMaster) {
      // Media playlist — estimate bandwidth from segment count + total duration
      const segCount = (text.match(/#EXTINF:/g) || []).length;
      if (segCount === 0) {
        result.maxBandwidth = 0;
        result.bestResolution = 'empty playlist';
        return result;
      }

      // Sum all segment durations to get total playlist duration
      const durationMatches = text.matchAll(/#EXTINF:([\d.]+)/g);
      let totalDuration = 0;
      for (const m of durationMatches) {
        totalDuration += parseFloat(m[1]) || 0;
      }

      // Download first segment to estimate actual bitrate
      // Try direct browser fetch first (same approach as m3u8 fetch)
      let estimatedBitrate = 1; // fallback: mark as valid but unknown
      try {
        const segLines = text.split('\n').map(l => l.trim()).filter(Boolean);
        let firstSegUrl = '';
        for (let i = 0; i < segLines.length; i++) {
          if (segLines[i].startsWith('#EXTINF:')) {
            // Next non-comment line is the segment URL
            for (let j = i + 1; j < segLines.length; j++) {
              if (!segLines[j].startsWith('#')) {
                firstSegUrl = resolveProbeUrl(source.url, segLines[j]);
                break;
              }
            }
            if (firstSegUrl) break;
          }
        }
        if (firstSegUrl) {
          let segData: ArrayBuffer | null = null;
          // Try direct browser fetch first (user's IP — works for CDNs that block datacenter IPs)
          try {
            const directResp = await fetch(firstSegUrl, {
              signal: AbortSignal.timeout(8000),
              mode: 'cors',
            });
            if (directResp.ok) {
              segData = await directResp.arrayBuffer();
            }
          } catch {
            // Direct fetch failed — fall through to proxy
          }
          // Fallback: proxy fetch
          if (!segData) {
            try {
              const proxyResp = await fetch(proxyUrl(firstSegUrl, referer), { signal: AbortSignal.timeout(10000) });
              if (proxyResp.ok) {
                segData = await proxyResp.arrayBuffer();
              }
            } catch {
              // Proxy also failed
            }
          }
          if (segData) {
            const segSizeBytes = segData.byteLength;
            const firstExtinf = text.match(/#EXTINF:([\d.]+)/);
            const segDuration = firstExtinf ? parseFloat(firstExtinf[1]) : 10;
            if (segDuration > 0 && segSizeBytes > 1000) {
              estimatedBitrate = Math.round((segSizeBytes * 8) / segDuration);
              console.log(
                `[SV DownloadService] Media playlist bitrate estimate: ` +
                `segment=${(segSizeBytes / 1024).toFixed(1)}KB, duration=${segDuration.toFixed(1)}s, ` +
                `bitrate=${(estimatedBitrate / 1000).toFixed(0)}kbps`
              );
            }
          }
        }
      } catch {
        // Bitrate estimation failed — non-critical, use fallback
      }

      result.maxBandwidth = estimatedBitrate;
      result.bestResolution = `media playlist (${segCount} segments, ${(totalDuration / 60).toFixed(1)}min, ~${(estimatedBitrate / 1000).toFixed(0)}kbps)`;

      // ── Try to find a master playlist variant on the same CDN ────────
      // If this is a media playlist (e.g., list.m3u8), try fetching master.m3u8
      // on the same base path. Master playlists contain quality variants
      // allowing us to select the highest quality stream.
      if (source.url.includes('list.m3u8') || source.url.includes('index.m3u8')) {
        const masterUrl = source.url.replace(/(list|index)\.m3u8$/, 'master.m3u8');
        if (masterUrl !== source.url) {
          try {
            const masterResult = await fetchM3u8WithFallback(masterUrl, referer, 8000);
            if (masterResult && masterResult.text.includes('#EXT-X-STREAM-INF')) {
              const masterLines = masterResult.text.split('\n').map(l => l.trim()).filter(Boolean);
              let maxBw = 0;
              let maxBwRes = '';
              for (let i = 0; i < masterLines.length; i++) {
                if (masterLines[i].startsWith('#EXT-X-STREAM-INF')) {
                  const bwMatch = masterLines[i].match(/BANDWIDTH=(\d+)/);
                  const resMatch = masterLines[i].match(/RESOLUTION=(\d+x\d+)/);
                  if (bwMatch) {
                    const bw = parseInt(bwMatch[1], 10);
                    if (bw > maxBw) {
                      maxBw = bw;
                      maxBwRes = resMatch?.[1] || '';
                    }
                  }
                }
              }
              if (maxBw > 0) {
                console.log(
                  `[SV DownloadService] Found master playlist variant: ${maxBwRes || 'unknown res'}, ` +
                  `maxBandwidth=${maxBw}, url='${masterUrl.substring(0, 80)}...'`
                );
                // Use the master playlist URL instead of the media playlist
                // Master playlist gives us quality variant selection
                result.url = masterUrl;
                result.maxBandwidth = maxBw;
                result.bestResolution = maxBwRes || `master playlist (up to ${(maxBw / 1000).toFixed(0)}kbps)`;
              }
            }
          } catch {
            // Master playlist not found on this CDN — use media playlist
          }
        }
      }

      return result;
    }

    // Master playlist — find the highest bandwidth variant
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    let maxBw = 0;
    let maxBwRes = '';

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
        const bwMatch = lines[i].match(/BANDWIDTH=(\d+)/);
        const resMatch = lines[i].match(/RESOLUTION=(\d+x\d+)/);
        if (bwMatch) {
          const bw = parseInt(bwMatch[1], 10);
          if (bw > maxBw) {
            maxBw = bw;
            maxBwRes = resMatch?.[1] || '';
          }
        }
      }
    }

    result.maxBandwidth = maxBw;
    result.bestResolution = maxBwRes;
  } catch {
    // Probe failed — source may be unreachable
  }

  return result;
}

/**
 * Probe all HLS sources and return the one with the highest quality.
 * Fetches each source's m3u8 manifest, parses variant bandwidths,
 * and picks the source with the highest max bandwidth.
 */
async function findBestHlsSource(
  sources: { url: string; quality: string; provider: string }[],
  referer?: string,
): Promise<{ url: string; quality: string; provider: string; maxBandwidth: number; bestResolution: string }> {
  if (sources.length <= 1) {
    // Only one source — just probe it for logging
    const probed = await probeHlsSource(sources[0], referer);
    console.log(
      `[SV DownloadService] Single HLS source probed: bandwidth=${probed.maxBandwidth}, ` +
      `resolution=${probed.bestResolution}, provider=${probed.provider}`,
    );
    return probed;
  }

  // Probe all sources in parallel (pass referer for CDN 403 handling)
  const probed = await Promise.all(sources.map(s => probeHlsSource(s, referer)));

  // Sort by max bandwidth descending
  probed.sort((a, b) => b.maxBandwidth - a.maxBandwidth);

  for (const p of probed) {
    console.log(
      `[SV DownloadService] Probed source: bandwidth=${p.maxBandwidth}, ` +
      `resolution=${p.bestResolution}, quality='${p.quality}', provider=${p.provider}, ` +
      `url='${p.url.substring(0, 80)}...'`,
    );
  }

  const best = probed[0];
  console.log(
    `[SV DownloadService] ✓ Best source selected: bandwidth=${best.maxBandwidth}, ` +
    `resolution=${best.bestResolution}, provider=${best.provider}`,
  );

  return best;
}

// ── Download Queue (module-level, FIFO) ────────────────────────────────────
const _queue: string[] = []; // task IDs in order of request
let _isProcessing = false;

// ── Active controller registry (module-level, survives component lifecycle) ──

const _controllers = new Map<string, AbortController>();

export function registerController(taskId: string, controller: AbortController): void {
  const existing = _controllers.get(taskId);
  if (existing) existing.abort();
  _controllers.set(taskId, controller);
}

export function cancelDownload(taskId: string): void {
  // Remove from queue if still waiting
  const queueIndex = _queue.indexOf(taskId);
  if (queueIndex !== -1) {
    _queue.splice(queueIndex, 1);
  }

  // Abort active download
  const controller = _controllers.get(taskId);
  if (controller) {
    controller.abort();
    _controllers.delete(taskId);
  }

  // Free in-memory blob cache
  evictBlob(taskId);

  // Clean up IndexedDB blob (fire-and-forget)
  deleteBlobFromStorage(taskId).catch(() => {});
}

export function removeController(taskId: string): void {
  _controllers.delete(taskId);
}

export function hasActiveController(taskId: string): boolean {
  return _controllers.has(taskId);
}

/** How many downloads are in the queue (including the one currently running) */
export function getQueueSize(): number {
  return _queue.length + (_isProcessing ? 1 : 0);
}

/** Position of a task in the queue (0 = currently active, -1 = not in queue) */
export function getQueuePosition(taskId: string): number {
  if (_controllers.has(taskId)) return 0; // currently downloading
  const idx = _queue.indexOf(taskId);
  return idx === -1 ? -1 : idx + (_isProcessing ? 1 : 0);
}

// ── Stale task cleanup (call on app startup) ────────────────────────────────
// When the app is closed/killed, in-flight downloads die but their tasks remain
// as 'downloading'/'pending' in the persisted store. Reset them to 'error' so
// the user can retry.

export function cleanupStaleTasks(): void {
  const store = useDownloadStore.getState();
  store.tasks.forEach((task) => {
    if (task.status === 'downloading' || task.status === 'pending') {
      store.updateTask(task.id, {
        status: 'error',
        error: 'Download was interrupted (app closed or restarted)',
      });
    }
  });
  // Clear any leftover queue entries
  _queue.length = 0;
  _isProcessing = false;
}

// ── Filename utility ────────────────────────────────────────────────────────

export function generateFilename(
  title: string,
  year?: string,
  season?: number,
  episode?: number,
): string {
  let name = `StreamVault - ${title}`;
  if (year) name += ` (${year})`;
  if (season !== undefined && episode !== undefined) {
    name += ` S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
  } else if (season !== undefined) {
    name += ` S${String(season).padStart(2, '0')}`;
  }
  return `${name}.mp4`;
}

// ── Download orchestration ─────────────────────────────────────────────────

interface DownloadConfig {
  contentId: string | number;
  mediaType: 'movie' | 'tv';
  title: string;
  posterUrl?: string;
  year?: string;
  season?: number;
  episode?: number;
}

/**
 * Start a download. Creates a task immediately (status: 'pending') and adds
 * it to the FIFO queue. Only one download runs at a time — the rest wait.
 */
export async function orchestrateDownload(config: DownloadConfig): Promise<void> {
  const store = useDownloadStore.getState();
  const { contentId, mediaType, title, posterUrl, year, season, episode } = config;

  // ── Duplicate guard ────────────────────────────────────
  const existing = store.getTaskForContent(contentId, season, episode);
  if (existing && (existing.status === 'downloading' || existing.status === 'pending')) {
    const pos = getQueuePosition(existing.id);
    if (pos <= 0) {
      toast.error('Already downloading', {
        description: 'This content is currently being downloaded.',
      });
    } else {
      toast.info('Already in queue', {
        description: `Queue position: #${pos}`,
      });
    }
    return;
  }

  // ── Clean up old error task for same content ───────────
  if (existing?.status === 'error') {
    store.removeTask(existing.id);
  }

  // ── Create task immediately with 'pending' status ──────
  // Visible in the UI right away (spinner + "Preparing...")
  const taskId = crypto.randomUUID();
  const task: DownloadTask = {
    id: taskId,
    contentId,
    title,
    mediaType,
    season,
    episode,
    quality: 'auto',
    status: 'pending',
    progress: 0,
    downloadedBytes: 0,
    totalBytes: 0,
    speed: 0,
    eta: 0,
    url: '',
    posterUrl,
    year,
    startedAt: Date.now(),
  };
  store.addTask(task);

  // ── Add to FIFO queue ──────────────────────────────────
  _queue.push(taskId);

  // Cache poster image for offline display (fire-and-forget)
  // Route through our proxy to avoid CORS (image.tmdb.org doesn't set Access-Control-Allow-Origin)
  if (posterUrl) {
    try {
      const posterResp = await fetch(proxyUrl(posterUrl));
      if (posterResp.ok) {
        const posterBlob = await posterResp.blob();
        await savePosterToStorage(contentId, posterBlob);
      }
    } catch {
      // Poster caching failed — non-critical
    }
  }

  const queuePosition = getQueuePosition(taskId);
  if (queuePosition > 1) {
    toast.info('Added to queue', {
      description: `${title} — position #${queuePosition}`,
    });
  }

  // ── Try to start processing ────────────────────────────
  _processQueue();
}

/**
 * Queue processor — runs downloads sequentially, one at a time.
 * When one finishes (success, error, or cancel), the next starts.
 */
async function _processQueue(): Promise<void> {
  if (_isProcessing) return;
  if (_queue.length === 0) return;

  _isProcessing = true;

  while (_queue.length > 0) {
    const taskId = _queue.shift()!;

    // Verify the task still exists and is still pending
    const store = useDownloadStore.getState();
    const task = store.getTask(taskId);
    if (!task || task.status !== 'pending') continue;

    // Run the actual download (fetches sources + downloads segments)
    await _executeDownload(task);
  }

  _isProcessing = false;
}

// ── Internal: execute download for a single queued task ─────────────────────

async function _executeDownload(task: DownloadTask): Promise<void> {
  const { contentId, mediaType, season, episode } = task;

  const controller = new AbortController();
  registerController(task.id, controller);

  try {
    // ── Step 1: Fetch stream sources ─────────────────────
    const response = await fetchStreamSources(contentId, mediaType, season, episode);

    if (controller.signal.aborted) {
      throw new DOMException('Download aborted', 'AbortError');
    }

    // Extract referer hint from embed URL
    // Pass the FULL embed URL (not just origin) — some CDNs check the full
    // Referer path for hotlink protection. E.g., conversionfocusedstudio.site
    // may require Referer: https://vidapi.ru/embed/xxxxx (not just https://vidapi.ru/)
    let referer: string | undefined;
    if (response?.embedUrl) {
      referer = response.embedUrl;
    }

    const sourceList = response?.sources;
    const downloadLinks = response?.downloadLinks;

    // Determine download URL and quality
    let downloadUrl = '';
    let quality = 'auto';

    // Priority 1: Direct download links (MP4)
    if (downloadLinks && downloadLinks.length > 0) {
      const sorted = [...downloadLinks].sort((a, b) => {
        const resA = parseInt(a.resolution) || 0;
        const resB = parseInt(b.resolution) || 0;
        return resB - resA;
      });
      const best = sorted[0];
      downloadUrl = best.url || best.streamUrl || '';
      quality = best.resolution || best.quality || 'auto';
    }

    // Priority 2: HLS sources from providers
    if (!downloadUrl) {
      if (!sourceList || !Array.isArray(sourceList) || sourceList.length === 0) {
        throw new Error('Download unavailable — no supported sources found');
      }
      const hlsSources = sourceList.filter((s) => s.type === 'hls');
      if (hlsSources.length > 0) {
        // Probe all HLS sources to find the one with the highest actual bandwidth.
        // Quality labels ('1080p', 'auto') from the API are unreliable — the only
        // way to know the real quality is to inspect the m3u8 manifest's variants.
        const best = await findBestHlsSource(
          hlsSources.map(s => ({ url: s.url, quality: s.quality || 'auto', provider: s.provider || 'unknown' })),
          referer,
        );
        downloadUrl = best.url;
        quality = best.bestResolution || best.quality || 'auto';
      } else {
        // No HLS sources — use whatever is available
        const source = sourceList[0];
        downloadUrl = source.url;
        quality = source.quality || 'auto';
      }
    }

    if (!downloadUrl) {
      throw new Error('Download unavailable — no URL found');
    }

    // Update task with resolved URL and quality
    useDownloadStore.getState().updateTask(task.id, { url: downloadUrl, quality });

    if (controller.signal.aborted) {
      throw new DOMException('Download aborted', 'AbortError');
    }

    // ── Step 2: Download the content ─────────────────────
    // Get user's preferred subtitle languages from settings store
    const settingsState = await import('@/store').then((m) => m.useSettingsStore.getState());
    const preferredSubtitles = settingsState.preferredSubtitles;
    const downloadFolderName = settingsState.downloadFolderName;

    const result: DownloadResult = await startHlsDownload(
      { ...task, url: downloadUrl, quality },
      (progressUpdate) => {
        useDownloadStore.getState().updateTask(task.id, {
          status: progressUpdate.status,
          progress: progressUpdate.progress,
          downloadedBytes: progressUpdate.downloadedBytes,
          totalBytes: progressUpdate.totalBytes,
          speed: progressUpdate.speed,
          eta: progressUpdate.eta,
        });
      },
      controller.signal,
      referer,
      preferredSubtitles.length > 0 ? preferredSubtitles : undefined,
    );

    const blob = result.blob;

    // ── Step 3: Post-download integrity validation ────────────────
    // The download completed without errors, but the blob might still be
    // corrupted (e.g., CDN returned error pages for most but not all segments,
    // or the remux produced a tiny/garbage file). Validate before saving.
    const isHlsDownload = downloadUrl.includes('.m3u8');
    const isRemuxedToMp4 = blob.type === 'video/mp4' && isHlsDownload;
    const finalBlob = blob;

    console.log(
      `[SV DownloadService] Download complete: blob.type='${blob.type}', ` +
      `size=${(blob.size / 1024 / 1024).toFixed(2)} MB, ` +
      `isHlsDownload=${isHlsDownload}, isRemuxedToMp4=${isRemuxedToMp4}, ` +
      `segmentMeta=${result.segmentMeta ? result.segmentMeta.length + ' entries' : 'none'}`,
    );

    // ── Final blob size sanity check ──────────────────────────────────
    // A valid movie/episode should be at least 1MB. If it's smaller,
    // the CDN almost certainly returned error pages or the stream was cut short.
    const MIN_VIDEO_BYTES = 1_000_000; // 1 MB
    if (finalBlob.size < MIN_VIDEO_BYTES) {
      throw new Error(
        `Downloaded file is only ${(finalBlob.size / 1024).toFixed(0)} KB — ` +
        `too small to be valid video (minimum expected: 1 MB). ` +
        `The video source may be unavailable or the CDN is blocking access. ` +
        `Try a different content source.`
      );
    }

    if (isHlsDownload && !isRemuxedToMp4) {
      console.warn(
        `[SV DownloadService] ⚠️ HLS download was NOT remuxed to MP4 — ` +
        `blob type is '${blob.type}' instead of 'video/mp4'. ` +
        `Playback will use the fragile MemoryHlsLoader+HLS.js path. ` +
        `The TS→MP4 remux likely failed — check [SV Remux] logs above for details.`,
      );
    } else if (isRemuxedToMp4) {
      console.log(
        `[SV DownloadService] ✓ HLS download successfully remuxed to MP4 — ` +
        `native playback guaranteed, no HLS.js needed.`,
      );
    }

    // ── Step 4: Save to IndexedDB ─────────────────────────────
    // Save blob to IndexedDB first (survives page reload)
    try {
      await saveBlobToStorage(task.id, finalBlob);
    } catch (_e) {
      // IndexedDB save failed — blob stays in memory only, will show "Reload" after refresh
    }

    // Save subtitles to IndexedDB if downloaded from HLS manifest
    const savedSubtitles: string[] = [];
    let allSubtitles: Record<string, string> = { ...(result.subtitles || {}) };
    let allSubtitleTracks: SubtitleTrackInfo[] = [...(result.subtitleTracks || [])];

    if (result.subtitles) {
      for (const [lang, vttContent] of Object.entries(result.subtitles)) {
        try {
          await saveSubtitleToStorage(task.id, lang, vttContent);
          savedSubtitles.push(lang);
        } catch {
          // Subtitle save failed — non-critical
        }
      }
    }

    // ── Step 4b: Fetch subtitles from external API if needed ──
    // Most CDN HLS manifests don't include subtitle tracks. When that happens,
    // we fetch subtitles from OpenSubtitles (if API key is configured) using
    // the content's TMDB ID. The user's preferred languages from settings
    // determine which languages to fetch.
    // Fetch subtitles from external API when:
    // 1. No subtitles were found in the HLS manifest, OR
    // 2. The user's preferred languages include languages not yet downloaded
    const missingLangs = preferredSubtitles.length > 0
      ? preferredSubtitles.filter(l => !savedSubtitles.includes(l))
      : savedSubtitles.length === 0 ? ['en'] : []; // Default to English if no prefs set
    if (missingLangs.length > 0) {
      try {
        const langs = missingLangs.join(',');
        const subParams = new URLSearchParams({
          id: String(contentId),
          type: mediaType,
          languages: langs,
        });
        if (mediaType === 'tv' && task.season !== undefined) {
          subParams.set('season', String(task.season));
        }
        if (mediaType === 'tv' && task.episode !== undefined) {
          subParams.set('episode', String(task.episode));
        }

        const subResp = await fetch(`/api/stream/subtitles?${subParams.toString()}`, {
          signal: AbortSignal.timeout(15000),
        });

        if (subResp.ok) {
          const subData = await subResp.json() as {
            subtitles?: Record<string, string>;
            tracks?: Array<{ language: string; name: string; isDefault: boolean }>;
          };

          if (subData.subtitles) {
            for (const [lang, vttContent] of Object.entries(subData.subtitles)) {
              if (!vttContent || typeof vttContent !== 'string') continue;
              try {
                await saveSubtitleToStorage(task.id, lang, vttContent);
                savedSubtitles.push(lang);
                allSubtitles[lang] = vttContent;
              } catch {
                // Subtitle save failed — non-critical
              }
            }
          }

          if (subData.tracks && subData.tracks.length > 0) {
            allSubtitleTracks = subData.tracks.map(t => ({
              language: t.language,
              name: t.name || t.language,
              isDefault: t.isDefault,
              isForced: false,
            }));
          }

          if (savedSubtitles.length > 0) {
            console.log(
              `[SV DownloadService] ✓ Fetched ${savedSubtitles.length} subtitle(s) from API: ` +
              savedSubtitles.join(', ')
            );
          }
        }
      } catch {
        // External subtitle fetch failed — non-critical, play without subtitles
      }
    }

    // Mark HLS downloads with segmentMeta so the player can generate
    // a fake m3u8 and use HLS.js for native TS demuxing.
    // fMP4 blobs (direct downloads) are played via direct blob URL.
    // Cache blob in module-level Map (NOT Zustand — React 19's structuredClone
    // fails with large Blobs: "Share too large"). IndexedDB is the persistent store;
    // this cache only provides fast access for immediate post-download playback.
    cacheBlob(task.id, finalBlob);

    // Auto-save to user's chosen download folder (if configured)
    // Folder structure: movies/{title}/ or series/{title}/season_{X}/episode_{Y}/
    if (downloadFolderName) {
      (async () => {
        try {
          const { loadDirectoryHandle } = await import('@/lib/download-storage');
          const dirHandle = await loadDirectoryHandle();
          if (!dirHandle) return;

          // Verify permission is still granted
          const perm = await dirHandle.queryPermission({ mode: 'readwrite' });
          if (perm !== 'granted') {
            const reqPerm = await dirHandle.requestPermission({ mode: 'readwrite' });
            if (reqPerm !== 'granted') return;
          }

          // Build folder path: movies/{title}/ or series/{title}/season_{X}/episode_{Y}/
          const safeTitle = task.title.replace(/[<>:"/\\|?*]/g, '_');
          let targetDir = dirHandle;

          if (task.mediaType === 'tv' && task.season !== undefined && task.episode !== undefined) {
            // Series: create series/{title}/season_{X}/episode_{Y}/
            const seriesDir = await dirHandle.getDirectoryHandle(safeTitle, { create: true });
            const seasonDir = await seriesDir.getDirectoryHandle(`season_${String(task.season).padStart(2, '0')}`, { create: true });
            targetDir = await seasonDir.getDirectoryHandle(`episode_${String(task.episode).padStart(2, '0')}`, { create: true });
          } else {
            // Movie: create movies/{title}/
            targetDir = await dirHandle.getDirectoryHandle(safeTitle, { create: true });
          }

          // Write video file
          const filename = generateFilename(task.title, task.year, task.season, task.episode);
          const fileHandle = await targetDir.getFileHandle(filename, { create: true });
          const writable = await fileHandle.createWritable();
          await writable.write(finalBlob);
          await writable.close();

          // Write subtitle files alongside the video (from HLS manifest + external API)
          if (Object.keys(allSubtitles).length > 0) {
            for (const [lang, vttContent] of Object.entries(allSubtitles)) {
              try {
                const subFilename = filename.replace('.mp4', `.${lang}.vtt`);
                const subHandle = await targetDir.getFileHandle(subFilename, { create: true });
                const subWritable = await subHandle.createWritable();
                await subWritable.write(vttContent);
                await subWritable.close();
              } catch {
                // Subtitle file write failed — non-critical
              }
            }
          }

          useDownloadStore.getState().updateTask(task.id, {
            fileHandleName: filename,
          });
        } catch {
          // Auto-save failed — blob is still in IndexedDB, user can save manually
        }
      })();
    }

    useDownloadStore.getState().updateTask(task.id, {
      status: 'completed',
      progress: 100,
      hasLocalCopy: true,
      completedAt: Date.now(),
      downloadedBytes: finalBlob.size,
      totalBytes: finalBlob.size,
      speed: 0,
      eta: 0,
      subtitleTracks: allSubtitleTracks.length > 0 ? allSubtitleTracks : result.subtitleTracks,
      hasSubtitles: savedSubtitles.length > 0,
      isHlsDownload,
      // Only store segmentMeta for raw TS downloads that need MemoryHlsLoader.
      // Remuxed MP4 downloads play directly via blob URL — no segmentMeta needed.
      segmentMeta: (isHlsDownload && !isRemuxedToMp4) ? result.segmentMeta : undefined,
    });

    removeController(task.id);

    toast.success('Download complete', {
      description: `${task.title} — go to Downloads to save or play`,
    });
  } catch (err) {
    removeController(task.id);
    // Free any partial blob cache from failed download
    evictBlob(task.id);

    if (err instanceof DOMException && err.name === 'AbortError') {
      // User cancelled — remove the task + clean IndexedDB
      useDownloadStore.getState().removeTask(task.id);
      deleteBlobFromStorage(task.id).catch(() => {});
    } else {
      const errorMessage = err instanceof Error ? err.message : 'Download failed';
      console.error(
        `[SV DownloadService] Download FAILED for '${task.title}': ${errorMessage}`
      );
      useDownloadStore.getState().updateTask(task.id, {
        status: 'error',
        error: errorMessage,
      });
      // Clean up any partial IndexedDB data
      deleteBlobFromStorage(task.id).catch(() => {});
      toast.error('Download failed', {
        description: `${task.title} — ${errorMessage}`,
      });
    }
  }
}
