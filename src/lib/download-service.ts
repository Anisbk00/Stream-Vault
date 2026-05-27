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
import { fetchExternalSubtitles } from './subtitle-fetcher';

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

function proxyUrl(targetUrl: string): string {
  return `${PROXY_BASE}?url=${encodeURIComponent(targetUrl)}`;
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
    let referer: string | undefined;
    if (response?.embedUrl) {
      try {
        referer = new URL(response.embedUrl).origin + '/';
      } catch {
        // ignore invalid URL
      }
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
      const source =
        sourceList.find((s) => s.type === 'hls' && s.quality !== 'auto') ||
        sourceList.find((s) => s.type === 'hls') ||
        sourceList[0];
      downloadUrl = source.url;
      quality = source.quality || 'auto';
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

    // Save subtitles to IndexedDB if downloaded
    const savedSubtitles: string[] = [];
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

    // ── Step 4b: External subtitle fallback ─────────────────────────
    // Most free streaming CDNs don't include #EXT-X-MEDIA TYPE=SUBTITLES
    // in their m3u8 manifests. When no subtitles were found in the manifest,
    // try fetching from external sources (SubDL, OpenSubtitles) using the
    // content's TMDB ID + user's preferred subtitle languages.
    let finalSubtitleTracks = result.subtitleTracks;
    if (savedSubtitles.length === 0 && contentId) {
      try {
        const externalResult = await fetchExternalSubtitles(
          contentId,
          mediaType,
          preferredSubtitles.length > 0 ? preferredSubtitles : [],
          season,
          episode,
        );

        if (externalResult.subtitles && Object.keys(externalResult.subtitles).length > 0) {
          for (const [lang, vttContent] of Object.entries(externalResult.subtitles)) {
            try {
              await saveSubtitleToStorage(task.id, lang, vttContent);
              savedSubtitles.push(lang);
            } catch {
              // Subtitle save failed — non-critical
            }
          }
          if (externalResult.subtitleTracks.length > 0) {
            finalSubtitleTracks = externalResult.subtitleTracks;
          }
        }
      } catch {
        // External subtitle fetch failed — non-critical, video is already downloaded
      }
    }

    // Build combined subtitles map for auto-save (m3u8 + external)
    const allSubtitlesForSave: Record<string, string> = { ...result.subtitles };
    if (savedSubtitles.length > 0) {
      for (const lang of savedSubtitles) {
        if (!allSubtitlesForSave[lang]) {
          try {
            const { loadSubtitle } = await import('@/lib/download-storage');
            const vttContent = await loadSubtitle(task.id, lang);
            if (vttContent) allSubtitlesForSave[lang] = vttContent;
          } catch {
            // Read back failed — skip this subtitle in auto-save
          }
        }
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

          // Write subtitle files alongside the video
          if (Object.keys(allSubtitlesForSave).length > 0) {
            for (const [lang, vttContent] of Object.entries(allSubtitlesForSave)) {
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
      subtitleTracks: finalSubtitleTracks,
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
