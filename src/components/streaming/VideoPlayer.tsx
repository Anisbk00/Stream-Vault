'use client';

import {
  useRef,
  useEffect,
  useState,
  useCallback,
  useMemo,
  Component,
  type ErrorInfo,
  type ReactNode,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import Hls from 'hls.js';
import { MemoryHlsLoader } from '@/lib/hls-memory-loader';
import { setupFmp4MseProgressive, combineFragmentPairs, parseFmp4Fragments, type ProgressiveMseHandle } from '@/lib/fmp4-mse-player';
import { getCachedSegments } from '@/lib/ts-to-mp4';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Play,
  Pause,
  Volume2,
  Volume1,
  VolumeX,
  Maximize,
  Minimize,
  ArrowLeft,

  PictureInPicture2,
  SkipBack,
  SkipForward,
  Loader2,
  AlertCircle,
  RotateCcw,
  ChevronDown,
  ExternalLink,
  Mic,
  MicOff,
  Subtitles,
  Captions,
  CaptionsOff,
  Languages,
  Plus,
  Minus,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useFullscreen, requestWakeLock, lockOrientation, unlockOrientation } from '@/hooks/use-fullscreen';
import { useExternalSubtitles } from '@/hooks/use-external-subtitles';
import { SubtitleOverlay } from '@/components/streaming/SubtitleOverlay';

// ─── Props ───────────────────────────────────────────────────────────────────

/** Watch Party sync configuration — when provided, the player syncs with a watch party */
export interface WatchPartySync {
  /** Whether the current user is the host */
  isHost: boolean;
  /** User ID of the person who paused (null if playing) */
  pausedBy: string | null;
  /** Called when the local user pauses playback */
  onPause: (currentTime: number) => void;
  /** Called when the local user plays/resumes playback */
  onPlay: (currentTime: number) => Promise<boolean>;
  /** Called when the local user seeks */
  onSeek: (currentTime: number) => Promise<boolean>;
  /** Called periodically to sync playback state */
  onSync: (currentTime: number, isPlaying: boolean, duration: number) => void;
  /** Pause notification to display (from another user pausing) */
  pauseNotification: { pausedByName: string; currentTime: number } | null;
  /** Called when PTT button is pressed (user starts speaking) */
  onPttStart?: () => void;
  /** Called when PTT button is released (user stops speaking) */
  onPttStop?: () => void;
  /** Whether PTT is currently active (user is speaking) */
  isPttActive?: boolean;
  /** Set of user IDs currently talking (for speaking indicators) */
  talkingMembers?: Set<string>;
  /** Host's current playback time — members seek to this when drift exceeds threshold */
  hostCurrentTime?: number;
  /** Whether the host is currently playing — members match this state */
  hostIsPlaying?: boolean;
  /** Party members list for displaying speaking indicators */
  members?: { userId: string; displayName: string; avatarUrl: string | null; isHost: boolean }[]
  /** Local user ID for identifying self in member list */
  localUserId?: string
  /**
   * The playback time at which the current party session started.
   * Unlike hostCurrentTime (overwritten every 500ms by host sync),
   * this stays fixed so the player can detect when an embed provider
   * resumes from its own saved progress instead of the party start.
   */
  partyStartTime: number
  /**
   * The sentAt (ms epoch) from the host's most recent sync broadcast.
   * Members use this to calculate one-way network latency for precise
   * drift compensation, replacing the hardcoded 0.25s guess.
   */
  lastSyncSentAt?: number
}

interface VideoPlayerProps {
  src: string;
  fallbackUrls?: string[];
  poster?: string;
  title?: string;
  startTime?: number;
  onClose: () => void;
  onProgressUpdate?: (time: number, duration: number) => void;
  onCompleted?: () => void;
  contentId?: string | number;
  mediaType?: 'movie' | 'tv';
  season?: number;
  episode?: number;
  autoPlay?: boolean;
  subtitleUrls?: Record<string, string>;
  /** Subtitle track metadata for UI display */
  subtitleTracks?: { language: string; name: string; isDefault: boolean }[];
  /** Force HLS.js playback (for fake m3u8 from downloaded content) */
  useHls?: boolean;
  /** ID for in-memory segment data (custom HLS.js loader bypasses blob URLs) */
  hlsPlaybackId?: string;
  /** fMP4 blob for MSE-based playback (downloaded HLS content remuxed to MP4) */
  fmp4Blob?: Blob;
  /** Watch Party sync — when provided, the player syncs playback with the party */
  watchPartySync?: WatchPartySync;
  /** IMDB ID for this content (used for external subtitle lookup) */
  imdbId?: string | null;
}

interface HlsLevel {
  height: number;
  width: number;
  bitrate: number;
  name?: string;
}

interface PlayerEventData {
  player_info?: {
    tmdb?: string | number;
    imdb?: string;
    mediaType?: string;
    season?: number;
    episode?: number;
    title?: string;
    poster?: string;
  };
  player_status?: 'playing' | 'paused' | 'completed' | 'seeked';
  player_progress?: number;
  player_duration?: number;
  quality?: { label?: string };
  availableQualities?: string[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function qualityLabel(height: number): string {
  if (height >= 2160) return '4K';
  if (height >= 1440) return '1440p';
  if (height >= 1080) return '1080p';
  if (height >= 720) return '720p';
  if (height >= 480) return '480p';
  if (height >= 360) return '360p';
  return `${height}p`;
}

const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;

function isEmbedUrl(src: string): boolean {
  return (
    /(?:vaplayer\.ru|vidapi\.)/i.test(src) ||
    /\/embed\//i.test(src) ||
    /vidsrc\./i.test(src) ||
    /embed\.su/i.test(src) ||
    /vsrc\.su/i.test(src) ||
    /vidsrcme\./i.test(src) ||
    /vidsrc-embed\./i.test(src) ||
    /vidsrc-me\./i.test(src) ||
    /filmu\.in/i.test(src) ||
    /vidlink\.pro/i.test(src) ||
    /vidfast\.(?:pro|net|in|io|me|pm|xyz)/i.test(src)
  );
}

// ── Global PTT portal mount point ──────────────────────────
// When the video player enters fullscreen, the Fullscreen API only renders
// descendants of the fullscreen element. The WatchPartyRoom's floating PTT
// button (portaled to document.body) is OUTSIDE the fullscreen element and
// gets hidden. This module-level ref lets the video player expose its
// container so PTT can portal INSIDE it during fullscreen.
let _playerContainerForPtt: HTMLDivElement | null = null;

export function getPlayerContainerForPtt(): HTMLDivElement | null {
  return _playerContainerForPtt;
}

function setPlayerContainerForPtt(el: HTMLDivElement | null) {
  _playerContainerForPtt = el;
}

/** Known embed provider origins — used for postMessage origin validation */
const ALLOWED_MESSAGE_ORIGINS = [
  'vidsrc.to', 'vidsrc.pm', 'vidsrc.me', 'vidsrc.cc',
  'vidsrc.fyi', 'vidsrc.ru',
  'vidsrcme.ru', 'vidsrcme.su', 'vidsrc-embed.ru', 'vidsrc-embed.su',
  'vidsrc-me.ru', 'vidsrc-me.su', 'vsrc.su',
  'vidapi.ru', 'vidapi.domains', 'vaplayer.ru', 'vidapi.to',
  'vidapi.bz', 'vidapi.me', 'vidapi.tw',
  'vidlink.pro', 'vidninja.pro',
  'vidfast.pro', 'vidfast.net', 'vidfast.in', 'vidfast.io', 'vidfast.me', 'vidfast.pm', 'vidfast.xyz',
  'embed.su', '2embed.cc', 'www.2embed.cc',
  'multiembed.mov', 'playembed.site',
  'embed.filmu.in', 'filmu.in',
];

function isAllowedMessageOrigin(origin: string): boolean {
  try {
    const hostname = new URL(origin).hostname;
    return ALLOWED_MESSAGE_ORIGINS.some(
      (allowed) => hostname === allowed || hostname.endsWith('.' + allowed),
    );
  } catch {
    return false;
  }
}

// ─── Iframe Embed Player ─────────────────────────────────────────────────────

/** Extract a human-readable provider label from URL */
function getProviderLabel(url: string): string {
  try {
    const hostname = new URL(url).hostname;
    if (hostname.includes('vidsrc.fyi')) return 'VidSrc.fyi';
    if (hostname.includes('vidsrc.ru')) return 'VidSrc.ru';
    if (hostname.includes('vidsrc.to')) return 'VidSrc';
    if (hostname.includes('vidsrc.cc')) return 'VidSrc.cc';
    if (hostname.includes('embed.su')) return 'EmbedSu';
    if (hostname.includes('vsrc.su') || hostname.includes('vidsrcme') || hostname.includes('vidsrc-embed')) return 'VidSrc.me';
    if (hostname.includes('vidapi') || hostname.includes('vaplayer')) return 'VidAPI';
    if (hostname.includes('vidlink')) return 'VidLink';
    if (hostname.includes('vidfast') || hostname.includes('vidninja')) return 'VidFast';
    if (hostname.includes('filmu')) return 'FilmU';
    return hostname.split('.').slice(-2).join('.');
  } catch {
    return 'Source';
  }
}

/** Normalise a source URL — strips proxy wrapper if present.
 *  We load embed URLs directly in the iframe (not through a server proxy)
 *  because the proxy changes the page origin, breaking Cloudflare JS,
 *  cookies, and the embed player's own API calls. This was the root cause
 *  of both the CORS errors on web and the "something went wrong" error in PWA.
 */
function unwrapProxyUrl(url: string): string {
  // If the URL is our proxy wrapper, extract the real URL
  const proxyPrefix = '/api/stream/embed?url=';
  if (url.startsWith(proxyPrefix)) {
    try {
      return decodeURIComponent(url.slice(proxyPrefix.length));
    } catch {
      return url;
    }
  }
  return url;
}

function IframeEmbedPlayer({
  src,
  fallbackUrls,
  title,
  mediaType,
  onClose,
  onProgressUpdate,
  onCompleted,
  watchPartySync,
  imdbId,
  contentId,
  season,
  episode,
}: {
  src: string;
  fallbackUrls?: string[];
  title?: string;
  mediaType?: 'movie' | 'tv';
  onClose: () => void;
  onProgressUpdate?: (time: number, duration: number) => void;
  onCompleted?: () => void;
  watchPartySync?: WatchPartySync;
  imdbId?: string | null;
  contentId?: string | number;
  season?: number;
  episode?: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Expose container to WatchPartyRoom for PTT portal in fullscreen
  const setContainerRef = useCallback((el: HTMLDivElement | null) => {
    containerRef.current = el;
    setPlayerContainerForPtt(el);
  }, []);

  const [showOverlay, setShowOverlay] = useState(false);
  // Fullscreen state: on iOS we use CSS fullscreen (position:fixed), on other
  // platforms we use the standard Fullscreen API. The `setIsFullscreen` setter
  // is used by the fullscreenchange listener to track API-based fullscreen.
  const [isFullscreen, setIsFullscreen] = useState(false);

  const [iframeTitle, setIframeTitle] = useState(title || '');

  // ── External subtitle state ────────────────────────────────
  // Track iframe playback time as state for subtitle sync (ref alone
  // won't trigger re-renders needed by the subtitle overlay).
  const [subtitleTime, setSubtitleTime] = useState(0);
  const [subtitleEnabled, setSubtitleEnabled] = useState(false);
  const [showSubtitleMenu, setShowSubtitleMenu] = useState(false);

  const {
    currentCue,
    tracks: subtitleTracks,
    selectedTrack,
    selectTrack: selectSubtitleTrack,
    clearTrack: clearSubtitleTrack,
    offset: subtitleOffset,
    adjustOffset: adjustSubtitleOffset,
    loading: subtitleLoading,
    error: subtitleError,
  } = useExternalSubtitles({
    tmdbId: contentId,
    imdbId: imdbId || undefined,
    mediaType,
    season,
    episode,
    currentTime: subtitleTime,
    enabled: subtitleEnabled,
  });

  // ── Watch Party iframe sync state ────────────────────────
  // Track the iframe's playback position from PLAYER_EVENT postMessages.
  // This is the ONLY way to know the iframe video's current time since
  // cross-origin iframes don't expose their DOM. The HlsVideoPlayer has
  // direct access to video.currentTime, but IframeEmbedPlayer must rely
  // on the embed provider's postMessage protocol.
  const iframeTimeRef = useRef(0);
  const iframeDurationRef = useRef(0);
  const iframePlayingRef = useRef(false);
  const hasReceivedProgressRef = useRef(false);
  const initialSyncDoneRef = useRef(false);
  const lastIframeSeekRef = useRef(0);

  // ── First-progress correction ────────────────────────────
  // Embed providers (vidsrc.to, vidapi.ru) save the user's watch
  // progress in their own cookies/localStorage and resume from there
  // on page load, IGNORING the ?t=0 query parameter. This means both
  // host and member can start from e.g. 45:00 instead of 0.
  // We detect this by capturing the first reported progress and
  // comparing it to partyStartTime (the expected start position).
  // If the drift exceeds a threshold, we immediately attempt correction.
  const wpFirstProgressCorrectedRef = useRef(false);
  const [wpFirstProgressTime, setWpFirstProgressTime] = useState<number | null>(null);

  // ── PostMessage sync detection ───────────────────────────
  // Most embed providers (vidapi.ru, vidsrc.to) only send OUTBOUND
  // PLAYER_EVENT postMessages but ignore inbound PLAYER_COMMAND messages.
  // We detect this by checking if the iframe time actually changes after
  // a seek command. Once detected as unsupported, we fall back to
  // URL reload sync which works universally.
  const postMessageSyncDetected = useRef<boolean | null>(null);
  // null = not yet tested, true = works, false = doesn't work
  const lastUrlReloadRef = useRef(0);
  const URL_RELOAD_COOLDOWN_MS = 30_000; // Don't reload more than once per 30s (prevents reload loops on slow PWA connections)

  // Source cycling state — use direct embed URLs (no proxy wrapping)
  // Proxy wrapping was the root cause of CORS errors on web and
  // "something went wrong" in PWA — it changes the page origin.
  // useMemo: allUrls is used as a useCallback dependency for tryNextSource.
  // Without memoization, it creates a new array ref every render →
  // tryNextSource recreates → useEffect([currentSrc, tryNextSource]) fires
  // every render → Turbopack build analysis fails on the unstable dep chain.
  const allUrls = useMemo(
    () => [src, ...(fallbackUrls || [])]
      .filter(Boolean)
      .map(unwrapProxyUrl)
      .map((url) => {
        // Watch Party: override embed provider's saved progress by appending
        // ?t=0 to the URL. Embed providers (vidapi.ru, vidsrc.to) remember
        // the user's last position and resume from there, which breaks sync
        // because the host may be at 45min while the member starts at 0.
        // ?t=0 forces both to start from the beginning.
        if (watchPartySync) {
          try {
            const u = new URL(url);
            u.searchParams.set('t', '0');
            return u.toString();
          } catch { /* not a valid URL, pass through */ }
        }
        return url;
      }),
    [src, fallbackUrls, watchPartySync],
  );
  const currentIndexRef = useRef(0);
  const [currentSrc, setCurrentSrc] = useState(() => allUrls[0] || '');
  const [currentLabel] = useState(() => (allUrls[0] ? getProviderLabel(allUrls[0]) : 'Source'));
  const [currentNum, setCurrentNum] = useState(1);
  const totalSources = allUrls.length;
  const [hasError, setHasError] = useState(allUrls.length === 0);
  const [isTrying, setIsTrying] = useState(allUrls.length > 0);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const iframeLoadedRef = useRef(false);
  // Video activity timer — detects broken embeds where iframe HTML loads
  // but the internal video player never starts (no PLAYER_EVENT received).
  // Without this, the user is permanently stuck on a dead embed showing
  // the provider's error message (e.g. vidapi.ru "Network error - all servers failed").
  const videoActivityTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const VIDEO_ACTIVITY_TIMEOUT_MS = 20_000; // 20s after iframe load — if no video activity, try next source
  const FAST_FAIL_ACTIVITY_TIMEOUT_MS = 3_000; // 3s for fast-loaded iframes (likely error pages)
  // Track when currentSrc was set — if onLoad fires within 2s, the page is
  // likely an error/redirect, not a real video embed (those take 3-5s minimum)
  const srcSetTimeRef = useRef(Date.now());

  // iOS detection — iOS Safari/WKWebView does NOT support requestFullscreen()
  // on <div> elements (only on <video> elements). We use CSS-based fullscreen
  // as a fallback: position:fixed covering the entire viewport.
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  // CSS-based fullscreen state for iOS (standard Fullscreen API doesn't work on divs)
  const [cssFullscreen, setCssFullscreen] = useState(false);

  // Fullscreen toggle — uses CSS fullscreen on iOS, standard API elsewhere.
  // On iOS, both cssFullscreen AND isFullscreen are updated together so
  // downstream UI (speaking indicator, button icon) works uniformly.
  const toggleFullscreen = useCallback(async () => {
    if (!containerRef.current) return;

    if (isIOS) {
      // iOS: toggle CSS-based fullscreen (position:fixed overlay)
      setCssFullscreen(prev => {
        const next = !prev;
        setIsFullscreen(next);
        return next;
      });
      return;
    }

    // Non-iOS: use standard Fullscreen API (setIsFullscreen updated via event listener)
    try {
      const doc = document as Document & { webkitFullscreenElement?: Element; webkitExitFullscreen?: () => Promise<void> };
      const isFullscreenNow = !!document.fullscreenElement || !!doc.webkitFullscreenElement;
      if (!isFullscreenNow) {
        const el = containerRef.current as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> };
        if (el.requestFullscreen) {
          await el.requestFullscreen();
        } else if (el.webkitRequestFullscreen) {
          await el.webkitRequestFullscreen();
        }
      } else {
        if (document.exitFullscreen) {
          await document.exitFullscreen();
        } else if (doc.webkitExitFullscreen) {
          await doc.webkitExitFullscreen();
        }
      }
    } catch {
      // Fullscreen not supported or blocked
    }
  }, [isIOS]);

  // Listen for fullscreen changes (both standard and webkit prefix)
  useEffect(() => {
    const handler = () => {
      const doc = document as Document & { webkitFullscreenElement?: Element };
      setIsFullscreen(!!document.fullscreenElement || !!doc.webkitFullscreenElement);
    };
    document.addEventListener('fullscreenchange', handler);
    document.addEventListener('webkitfullscreenchange', handler);
    return () => {
      document.removeEventListener('fullscreenchange', handler);
      document.removeEventListener('webkitfullscreenchange', handler);
    };
  }, []);

  // Auto-enter fullscreen on first load (mobile)
  useEffect(() => {
    if (isIOS) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- auto-enter CSS fullscreen on iOS mount
      setCssFullscreen(true);
      return;
    }
    const isMobile = /Android/i.test(navigator.userAgent);
    const el = containerRef.current as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> } | null;
    if (isMobile && el) {
      if (el.requestFullscreen) {
        el.requestFullscreen().catch(() => {});
      } else if (el.webkitRequestFullscreen) {
        el.webkitRequestFullscreen().catch(() => {});
      }
    }
  }, [isIOS]);

  // Try the next fallback URL (with delay to prevent rapid iframe flashing)
  const tryNextSource = useCallback((immediate = false) => {
    const nextIndex = currentIndexRef.current + 1;
    if (nextIndex < allUrls.length) {
      currentIndexRef.current = nextIndex;
      setCurrentNum(nextIndex + 1);
      setHasError(false);
      setIsTrying(true);
      iframeLoadedRef.current = false;
      srcSetTimeRef.current = Date.now();

      // Add a small delay before switching to avoid rapid iframe replacement
      // when multiple sources fail quickly (e.g., Cloudflare blocks)
      if (!immediate) {
        setTimeout(() => {
          srcSetTimeRef.current = Date.now();
          setCurrentSrc(allUrls[nextIndex]);
        }, 800);
      } else {
        setCurrentSrc(allUrls[nextIndex]);
      }
    } else {
      setHasError(true);
      setIsTrying(false);
    }
  }, [allUrls]);

  // Timeout: if embed doesn't load within 12s, try next source
  useEffect(() => {
    if (loadTimeoutRef.current) clearTimeout(loadTimeoutRef.current);
    srcSetTimeRef.current = Date.now();

    loadTimeoutRef.current = setTimeout(() => {
      // iframe didn't signal it loaded — try next (with delay already built-in)
      if (!iframeLoadedRef.current) {
        tryNextSource();
      }
    }, 12000);

    return () => {
      if (loadTimeoutRef.current) clearTimeout(loadTimeoutRef.current);
      if (videoActivityTimeoutRef.current) clearTimeout(videoActivityTimeoutRef.current);
    };
  }, [currentSrc, tryNextSource]);

  // Detect iframe load via iframe onload event
  const handleIframeLoad = useCallback(() => {
    // iframe loaded something — mark as loaded so timeout doesn't cycle
    iframeLoadedRef.current = true;
    setIsTrying(false);
    if (loadTimeoutRef.current) {
      clearTimeout(loadTimeoutRef.current);
      loadTimeoutRef.current = null;
    }
    // Fast-fail detection: if onLoad fires within 2s of setting the src,
    // the page is likely a network error page (chrome-error://chromewebdata/),
    // a content-unavailable page ("This media is not available"), or a
    // lightweight error — not a real video embed. Real embed providers take
    // 3-5s minimum to load (player JS, video init).
    const loadDurationMs = Date.now() - srcSetTimeRef.current;
    const isFastLoad = loadDurationMs < 2000;
    const activityTimeout = isFastLoad ? FAST_FAIL_ACTIVITY_TIMEOUT_MS : VIDEO_ACTIVITY_TIMEOUT_MS;
    // Start video activity timer — if no PLAYER_EVENT is received within
    // the timeout, the embed is considered broken.
    if (videoActivityTimeoutRef.current) clearTimeout(videoActivityTimeoutRef.current);
    videoActivityTimeoutRef.current = setTimeout(() => {
      // Only cycle if we haven't received any PLAYER_EVENT yet
      if (!hasReceivedProgressRef.current && !iframePlayingRef.current) {
        tryNextSource();
      }
    }, activityTimeout);
  }, [tryNextSource]);

  // Listen for PLAYER_EVENT postMessage from iframe
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      // SECURITY: Validate message origin — only accept PLAYER_EVENT from known embed providers.
      // Prevents malicious iframes from triggering fake progress/completed events
      // or manipulating player state (auto-advance, title injection, etc.).
      if (event.origin && !isAllowedMessageOrigin(event.origin)) return;

      if (event.data && typeof event.data === 'object' && event.data.type === 'PLAYER_EVENT') {
        const data: PlayerEventData = event.data.data;

        // Clear the load timeout — iframe is actively playing
        iframeLoadedRef.current = true;
        setIsTrying(false);
        if (loadTimeoutRef.current) {
          clearTimeout(loadTimeoutRef.current);
          loadTimeoutRef.current = null;
        }
        // Clear video activity timer — embed is confirmed working
        if (videoActivityTimeoutRef.current) {
          clearTimeout(videoActivityTimeoutRef.current);
          videoActivityTimeoutRef.current = null;
        }

        if (!data) return;

        if (data.player_info?.title) {
          setIframeTitle(data.player_info.title);
        }

        // Track iframe playback state for watch party sync
        if (data.player_progress !== undefined) {
          const isFirstProgress = !hasReceivedProgressRef.current;
          iframeTimeRef.current = data.player_progress;
          setSubtitleTime(data.player_progress);
          hasReceivedProgressRef.current = true;

          // Capture first progress for watch party correction.
          // Embed providers may resume from their own saved progress,
          // ignoring ?t=0. We need to detect and correct this.
          if (isFirstProgress && watchPartySync && !wpFirstProgressCorrectedRef.current) {
            wpFirstProgressCorrectedRef.current = true;
            setWpFirstProgressTime(data.player_progress);
          }
        }
        if (data.player_duration !== undefined) {
          iframeDurationRef.current = data.player_duration;
        }
        if (data.player_status === 'playing') {
          iframePlayingRef.current = true;
          if (onProgressUpdate && data.player_progress !== undefined && data.player_duration !== undefined) {
            onProgressUpdate(data.player_progress, data.player_duration);
          }
        } else if (data.player_status === 'paused') {
          iframePlayingRef.current = false;
        }

        if (data.player_status === 'completed') {
          if (onCompleted) {
            onCompleted();
          }
        }
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [onProgressUpdate, onCompleted]);

  // ── Watch Party: Host sync broadcast ─────────────────────
  // Host broadcasts its current playback time every 250ms so members
  // can sync. Since we can't access iframe.currentTime (cross-origin),
  // we use the time reported by PLAYER_EVENT postMessages.
  useEffect(() => {
    if (!watchPartySync?.isHost) return;
    const interval = setInterval(() => {
      if (!hasReceivedProgressRef.current) return;
      watchPartySync.onSync(iframeTimeRef.current, iframePlayingRef.current, iframeDurationRef.current);
    }, 250);
    return () => clearInterval(interval);
  }, [watchPartySync?.isHost, watchPartySync?.onSync]);

  // ── Watch Party: Send postMessage command to iframe ───────
  // Attempts to control the iframe's video playback via postMessage.
  // Most embed providers IGNORE inbound commands (one-way outbound only).
  // A verification check after seek detects whether the provider responds.
  const sendIframeCommand = useCallback((action: 'play' | 'pause' | 'seek', time?: number) => {
    const iframe = iframeRef.current;
    if (!iframe?.contentWindow) return;

    // If we already know postMessage sync doesn't work, skip entirely
    if (postMessageSyncDetected.current === false && action === 'seek') return;

    try {
      iframe.contentWindow.postMessage(
        { type: 'PLAYER_COMMAND', action, time },
        '*',
      );
    } catch {
      // Cross-origin restriction or iframe not ready
    }

    // Verification: after sending a seek, check in 3s if the iframe time
    // actually moved. If not, the provider doesn't support inbound commands.
    if (action === 'seek' && time !== undefined && postMessageSyncDetected.current === null) {
      const timeBeforeSeek = iframeTimeRef.current;
      setTimeout(() => {
        const timeAfterSeek = iframeTimeRef.current;
        const expectedDiff = Math.abs(timeAfterSeek - timeBeforeSeek);
        // If the time hasn't changed significantly but we asked for a big jump,
        // the provider is ignoring our commands
        if (Math.abs(time - timeBeforeSeek) > 3 && expectedDiff < 2) {
          postMessageSyncDetected.current = false;
          console.log('[WatchParty] iframe does not respond to PLAYER_COMMAND — falling back to URL reload sync');
        } else {
          postMessageSyncDetected.current = true;
          console.log('[WatchParty] iframe responds to PLAYER_COMMAND — using postMessage sync');
        }
      }, 3000);
    }
  }, []);

  // ── Watch Party: First-progress correction ───────────────
  // When the embed provider sends its first player_progress event,
  // compare it to partyStartTime. Embed providers save user progress
  // in their own storage and resume from there on load, ignoring ?t=0.
  // This effect detects the mismatch and immediately attempts to seek
  // or reload. Works for BOTH host and member (unlike drift correction
  // which only runs for members).
  useEffect(() => {
    if (wpFirstProgressTime === null) return;
    if (!watchPartySync) return;

    const expectedTime = watchPartySync.partyStartTime ?? 0;
    const actualTime = wpFirstProgressTime;
    const drift = Math.abs(actualTime - expectedTime);

    // Only correct if the drift is significant (>3s). Small drifts
    // are handled by the normal drift correction mechanism.
    if (drift > 3) {
      const targetTime = Math.round(expectedTime) || 0;
      // Immediately try postMessage seek
      sendIframeCommand('seek', targetTime);

      // For hosts: also reload the iframe URL with the correct time.
      // Unlike members (who have initialSyncDoneRef), the host has no
      // URL-reload fallback, so we do it here for reliability.
      if (watchPartySync.isHost) {
        try {
          const url = new URL(currentSrc);
          url.searchParams.set('t', String(targetTime));
          url.searchParams.set('_wp', String(Date.now()));
          iframeLoadedRef.current = false;
          queueMicrotask(() => setCurrentSrc(url.toString()));
        } catch {
          // URL parse failed — postMessage seek is already attempted above
        }
      }
    }
  }, [wpFirstProgressTime]);

  // ── Watch Party: Member initial sync (one-time) ──────────
  // When a member joins mid-movie, the host may already be minutes in.
  // The iframe starts from 0 by default. We reload the iframe URL with
  // ?t={hostTime} query parameter so it starts at the correct position.
  // This is more reliable than hash parameters (#t=) because embed
  // providers use hash for their own config (e.g. #quality=1080p).
  // Uses setCurrentSrc() for proper React lifecycle (key prop remount).
  //
  // IMPORTANT: We ALWAYS perform the reload (even when hostTime is 0)
  // because embed providers (vidapi.ru, vidsrc.to) remember the user's
  // previous progress in their own storage and may resume from there,
  // ignoring ?t=0. A full iframe reload is the only way to force
  // the embed provider to start from the correct position.
  useEffect(() => {
    if (!watchPartySync || watchPartySync.isHost) return;
    if (initialSyncDoneRef.current) return;
    if (watchPartySync.hostCurrentTime === undefined || watchPartySync.hostCurrentTime === null) return;

    if (!iframeLoadedRef.current) return;

    const hostTime = watchPartySync.hostCurrentTime;
    // Calculate one-way latency from the sync broadcast's sentAt timestamp.
    // Falls back to 0.3s if sentAt is unavailable (first sync before broadcast).
    const oneWayLatency = watchPartySync.lastSyncSentAt
      ? Math.min((Date.now() - watchPartySync.lastSyncSentAt) / 1000, 2)
      : 0.3;
    const targetTime = Math.max(0, Math.round(hostTime + oneWayLatency));

    initialSyncDoneRef.current = true;

    try {
      const url = new URL(currentSrc);
      // Use query parameter ?t= instead of hash #t= — more widely supported
      // by embed providers (vidapi.ru, vidsrc.to, embed.su)
      url.searchParams.set('t', String(targetTime));
      // Add a cache-busting parameter to force the iframe to actually reload.
      // Without this, if the URL is identical (e.g. ?t=0 was already set),
      // React's key-based remount doesn't fire and the embed provider doesn't
      // reload — it just resumes from its saved progress.
      url.searchParams.set('_wp', String(Date.now()));
      iframeLoadedRef.current = false;
      // Schedule state update outside effect to avoid cascading renders.
      // The key={currentSrc} prop will remount the iframe on next render.
      const newUrl = url.toString();
      queueMicrotask(() => setCurrentSrc(newUrl));
    } catch {
      // URL parse failed — postMessage seek as last resort
      sendIframeCommand('seek', targetTime);
    }
  }, [watchPartySync?.isHost, watchPartySync?.hostCurrentTime, currentSrc, sendIframeCommand]);

  // ── Watch Party: Member ongoing drift correction ──────────
  // After initial sync, continuously correct drift. Two sync strategies:
  //   1. postMessage seek (if provider supports inbound commands)
  //   2. URL reload fallback (if postMessage is detected as unsupported)
  // URL reload is disruptive (full page reload inside iframe) but is
  // the ONLY reliable way to sync with providers that ignore postMessage.
  // Dual mechanism (same pattern as HlsVideoPlayer):
  //   A. Effect-based: triggers when hostCurrentTime prop changes
  //   B. Interval-based: polls every 1s to catch drift between broadcasts
  const URL_RELOAD_DRIFT_THRESHOLD = 8; // Only URL-reload for drifts > 8s (higher threshold to prevent reload loops on slow PWA/cellular)

  // Helper: reload iframe URL with ?t= parameter
  // Uses direct DOM mutation instead of setCurrentSrc to avoid setState-in-effect.
  // Acceptable here because URL reload is already disruptive (full page reload).
  const reloadIframeAtTime = useCallback((targetTime: number) => {
    const now = Date.now();
    if (now - lastUrlReloadRef.current < URL_RELOAD_COOLDOWN_MS) return;
    lastUrlReloadRef.current = now;

    const iframe = iframeRef.current;
    if (!iframe) return;

    try {
      const url = new URL(currentSrc);
      url.searchParams.set('t', String(Math.round(targetTime)));
      iframeLoadedRef.current = false;
      iframe.src = url.toString();
    } catch {
      // URL parse failed
    }
  }, [currentSrc]);

  // Helper: calculate dynamic latency offset from sync broadcast's sentAt.
  // Falls back to 0.25s when sentAt is unavailable.
  const calcLatencyOffset = useCallback((sentAt?: number) => {
    if (!sentAt) return 0.25;
    const raw = (Date.now() - sentAt) / 1000;
    // Sanity bounds: 0.05s minimum (local/CDN), 2s maximum (extreme network)
    return Math.max(0.05, Math.min(raw, 2));
  }, []);

  // Effect-based drift correction
  useEffect(() => {
    if (!watchPartySync || watchPartySync.isHost) return;
    if (!hasReceivedProgressRef.current) return;
    if (!initialSyncDoneRef.current) return;
    if (watchPartySync.hostCurrentTime === undefined || watchPartySync.hostCurrentTime === null) return;

    const myTime = iframeTimeRef.current;
    const hostTime = watchPartySync.hostCurrentTime;
    const safeTarget = iframeDurationRef.current > 0 ? iframeDurationRef.current - 0.1 : hostTime + 10;
    const latencyOffset = calcLatencyOffset(watchPartySync.lastSyncSentAt);
    const targetTime = Math.min(hostTime + latencyOffset, safeTarget);
    const drift = Math.abs(myTime - targetTime);

    const SYNC_THRESHOLD = 0.3; // seconds — seek for drifts above this
    const EMERGENCY_THRESHOLD = 1.5; // seconds — immediate seek, bypass throttle
    const THROTTLE_MS = 500; // ms — minimum between seeks

    if (drift > EMERGENCY_THRESHOLD) {
      if (postMessageSyncDetected.current === false && drift > URL_RELOAD_DRIFT_THRESHOLD) {
        // postMessage doesn't work and drift is large — reload URL
        reloadIframeAtTime(targetTime);
      } else {
        // Try postMessage first (verification will detect if it doesn't work)
        sendIframeCommand('seek', Math.round(targetTime));
      }
      lastIframeSeekRef.current = Date.now();
    } else if (drift > SYNC_THRESHOLD) {
      const now = Date.now();
      if (now - lastIframeSeekRef.current < THROTTLE_MS) return;
      lastIframeSeekRef.current = now;
      // Only use postMessage for small drifts (URL reload too disruptive)
      sendIframeCommand('seek', Math.round(targetTime));
    }
  }, [watchPartySync?.hostCurrentTime, watchPartySync?.hostIsPlaying, watchPartySync?.isHost, watchPartySync?.lastSyncSentAt, sendIframeCommand, reloadIframeAtTime, calcLatencyOffset]);

  // Interval-based drift correction (polls every 1s)
  useEffect(() => {
    if (!watchPartySync || watchPartySync.isHost) return;
    const sync = watchPartySync;

    const interval = setInterval(() => {
      if (!hasReceivedProgressRef.current) return;
      if (!initialSyncDoneRef.current) return;
      if (sync.hostCurrentTime === undefined || sync.hostCurrentTime === null) return;
      if (!sync.hostIsPlaying) return;

      const myTime = iframeTimeRef.current;
      const hostTime = sync.hostCurrentTime;
      const safeTarget = iframeDurationRef.current > 0 ? iframeDurationRef.current - 0.1 : hostTime + 10;
      const latencyOffset = calcLatencyOffset(sync.lastSyncSentAt);
      const targetTime = Math.min(hostTime + latencyOffset, safeTarget);
      const drift = Math.abs(myTime - targetTime);

      if (drift > URL_RELOAD_DRIFT_THRESHOLD && postMessageSyncDetected.current === false) {
        // Large drift + postMessage doesn't work — reload URL
        reloadIframeAtTime(targetTime);
      } else if (drift > 1.5) {
        sendIframeCommand('seek', Math.round(targetTime));
        lastIframeSeekRef.current = Date.now();
      } else if (drift > 0.3) {
        const now = Date.now();
        if (now - lastIframeSeekRef.current < 500) return;
        lastIframeSeekRef.current = now;
        sendIframeCommand('seek', Math.round(targetTime));
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [watchPartySync?.isHost, watchPartySync?.hostCurrentTime, watchPartySync?.hostIsPlaying, sendIframeCommand, reloadIframeAtTime]);

  // ── Watch Party: Member play/pause matching ───────────────
  useEffect(() => {
    if (!watchPartySync || watchPartySync.isHost) return;
    if (!initialSyncDoneRef.current) return;

    if (watchPartySync.hostIsPlaying && !iframePlayingRef.current) {
      sendIframeCommand('play');
    } else if (!watchPartySync.hostIsPlaying && iframePlayingRef.current) {
      sendIframeCommand('pause');
    }
  }, [watchPartySync?.hostIsPlaying, watchPartySync?.isHost, sendIframeCommand]);

  // ── Watch Party: Member react to remote pause/play ───────
  const prevPausedByRef = useRef<string | null>(null);
  useEffect(() => {
    if (!watchPartySync) return;
    const prev = prevPausedByRef.current;

    if (watchPartySync.pausedBy && !prev) {
      sendIframeCommand('pause');
    }
    if (!watchPartySync.pausedBy && prev) {
      sendIframeCommand('play');
    }
    prevPausedByRef.current = watchPartySync.pausedBy;
  }, [watchPartySync?.pausedBy, sendIframeCommand]);

  const wakeLockRef = useRef<(() => void) | null>(null);

  // Orientation lock + wake lock when iframe content loads
  useEffect(() => {
    if (!iframeLoadedRef.current) return;
    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
    if (!isMobile) return;
    lockOrientation('landscape').catch(() => {});
    requestWakeLock().then((release) => {
      wakeLockRef.current = release;
    });
    return () => {
      unlockOrientation();
      if (wakeLockRef.current) {
        wakeLockRef.current();
        wakeLockRef.current = null;
      }
    };
  }, [currentSrc]);

  // Detect touch device — on mobile, overlay stays visible (back/fullscreen
  // at top don't overlap with embed's quality controls at bottom).
  // On desktop, overlay auto-hides (mousemove brings it back).
  const isTouchDevice = useRef(false);

  // Auto-hide overlay after 3 seconds (desktop only via mousemove)
  const resetHideTimer = useCallback(() => {
    setShowOverlay(true);
    if (isTouchDevice.current) return; // Don't auto-hide on touch devices
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => {
      setShowOverlay(false);
    }, 3000);
  }, []);

  useEffect(() => {
    // Detect touch capability once
    isTouchDevice.current = 'ontouchstart' in window || navigator.maxTouchPoints > 0;

    queueMicrotask(() => {
      setShowOverlay(true);
    });
    // On touch devices, overlay stays forever — no auto-hide timer
    if (!isTouchDevice.current) {
      hideTimerRef.current = setTimeout(() => {
        setShowOverlay(false);
      }, 3000);
    }
    return () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      if (loadTimeoutRef.current) clearTimeout(loadTimeoutRef.current);
      if (wakeLockRef.current) {
        wakeLockRef.current();
        wakeLockRef.current = null;
      }
      unlockOrientation();
    };
  }, []);

  return (
    <div
      ref={setContainerRef}
      className="fixed inset-0 z-[100] bg-black overflow-hidden"
      style={cssFullscreen ? {
        zIndex: 2147483647,
        width: '100dvw',
        height: '100dvh',
      } : undefined}
      onMouseMove={resetHideTimer}
    >
      {/* Error state - all sources failed */}
      <AnimatePresence>
        {hasError && (
          <motion.div
            className="absolute inset-0 z-[120] flex flex-col items-center justify-center gap-4 bg-black/90"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <AlertCircle className="h-14 w-14 text-sv-red" />
            <p className="text-white/80 text-sm max-w-xs text-center px-4">
              Unable to load this content. All sources failed — it may not be available right now.
            </p>
            <div className="flex flex-col gap-2.5 items-center">
              <div className="flex gap-3">
                <button
                  onClick={() => {
                    if (allUrls.length === 0) return;
                    currentIndexRef.current = 0;
                    setCurrentSrc(allUrls[0]);
                    // label no longer shown in UI
                    setCurrentNum(1);
                    setHasError(false);
                    setIsTrying(true);
                    iframeLoadedRef.current = false;
                  }}
                  className="px-5 py-2.5 rounded-lg bg-white/10 hover:bg-white/20 text-white text-sm font-medium transition-colors cursor-pointer"
                >
                  Retry
                </button>
                <button
                  onClick={onClose}
                  className="px-5 py-2.5 rounded-lg bg-sv-red hover:bg-sv-red-hover text-white text-sm font-medium transition-colors cursor-pointer"
                >
                  Go Back
                </button>
              </div>
              {title && (
                <button
                  onClick={() => {
                    const searchSuffix = mediaType === 'tv' ? 'series' : 'full movie';
                    const query = encodeURIComponent(`${title} ${searchSuffix}`);
                    window.open(`https://www.youtube.com/results?search_query=${query}`, '_blank');
                  }}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg bg-[#FF0000]/15 hover:bg-[#FF0000]/25 text-red-400 hover:text-red-300 text-xs font-medium transition-colors cursor-pointer"
                >
                  <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 fill-current">
                    <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814z"/>
                    <path fill="#fff" d="M9.545 15.568V8.432L15.818 12z"/>
                  </svg>
                  Search on YouTube
                  <ExternalLink className="h-3 w-3" />
                </button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* No loading spinner — embed providers have their own native loading UI.
          Showing our spinner on top causes double loading indicators. */}

      {/* Source cycling is silent — no skip button shown */}

      {/* Watch Party pause notification */}
      {watchPartySync?.pauseNotification && (
        <motion.div
          key={watchPartySync.pauseNotification.currentTime}
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 20 }}
          className="absolute bottom-20 left-1/2 -translate-x-1/2 z-[110] bg-black/80 backdrop-blur-md text-white text-xs font-medium px-4 py-2 rounded-full"
        >
          Paused by {watchPartySync.pauseNotification.pausedByName}
        </motion.div>
      )}

      {/* Iframe — loads embed URL directly (not through proxy).
          Direct loading preserves the embed's origin so Cloudflare JS,
          cookies, and the player's API calls all work correctly.
          This works in both browser and PWA standalone mode. */}
      <iframe
        key={currentSrc}
        ref={iframeRef}
        src={currentSrc}
        className="absolute inset-0 h-full w-full border-0"
        sandbox="allow-scripts allow-same-origin"
        allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
        referrerPolicy="origin"
        title={iframeTitle || 'Video Player'}
        onLoad={handleIframeLoad}
        onError={() => {
          tryNextSource();
        }}
      />

      {/* External subtitle overlay — synced to iframe playback time */}
      <SubtitleOverlay
        cue={currentCue}
        offset={subtitleOffset}
        loading={subtitleLoading}
        error={subtitleError}
      />

      {/* Subtitle controls — bottom-left, always visible when CC is on */}
      {subtitleEnabled && selectedTrack && (
        <div className="absolute bottom-3 left-3 z-[116] flex items-center gap-1">
          {/* Offset adjust */}
          <button
            onClick={() => adjustSubtitleOffset(-0.5)}
            className="flex items-center justify-center h-8 w-8 rounded-md bg-black/60 text-white/80 hover:text-white hover:bg-black/80 transition-colors text-xs"
            aria-label="Subtitle earlier"
          >
            <Minus className="h-3 w-3" />
          </button>
          <span className="text-[10px] text-white/70 bg-black/60 px-1.5 py-1 rounded min-w-[48px] text-center font-mono">
            {subtitleOffset === 0 ? 'Sync' : `${subtitleOffset > 0 ? '+' : ''}${subtitleOffset.toFixed(1)}s`}
          </span>
          <button
            onClick={() => adjustSubtitleOffset(0.5)}
            className="flex items-center justify-center h-8 w-8 rounded-md bg-black/60 text-white/80 hover:text-white hover:bg-black/80 transition-colors text-xs"
            aria-label="Subtitle later"
          >
            <Plus className="h-3 w-3" />
          </button>
        </div>
      )}

      {/* Controls overlay — shows on tap, auto-hides after 3s
          on desktop. Stays visible on touch devices. */}
      <AnimatePresence>
        {showOverlay && !isTrying && (
          <motion.div
            className="absolute top-0 left-0 right-0 z-[115] flex items-center justify-between px-4"
            style={{ paddingTop: 'max(1rem, calc(env(safe-area-inset-top, 0px) + 0.25rem))' }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.25 }}
          >
            {/* Back button */}
            <button
              onClick={onClose}
              className="flex items-center gap-2 text-white/90 hover:text-white transition-colors min-h-[44px] min-w-[44px] justify-start rounded-lg hover:bg-white/10 -ml-1"
              aria-label="Go back"
            >
              <ArrowLeft className="h-6 w-6" />
            </button>

            {/* Right-side controls: CC → Fullscreen */}
            <div className="flex items-center">
              {/* CC / Subtitle toggle button */}
              <div className="relative">
                <button
                  onClick={() => {
                    if (subtitleEnabled) {
                      setSubtitleEnabled(false);
                      setShowSubtitleMenu(false);
                    } else {
                      setSubtitleEnabled(true);
                      setShowSubtitleMenu(true);
                    }
                  }}
                  className={cn(
                    'flex items-center justify-center min-h-[44px] min-w-[44px] rounded-lg hover:bg-white/10 transition-colors',
                    subtitleEnabled ? 'text-yellow-400' : 'text-white/90 hover:text-white',
                  )}
                  aria-label={subtitleEnabled ? 'Disable subtitles' : 'Enable subtitles'}
                >
                  {subtitleEnabled ? <Captions className="h-5 w-5" /> : <CaptionsOff className="h-5 w-5" />}
                </button>

                {/* Subtitle language dropdown */}
                <AnimatePresence>
                  {showSubtitleMenu && subtitleEnabled && (
                    <>
                      <div className="fixed inset-0 z-[0]" onClick={() => setShowSubtitleMenu(false)} />
                      <motion.div
                        initial={{ opacity: 0, y: -4 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -4 }}
                        transition={{ duration: 0.15 }}
                        className="absolute top-full right-0 mt-1 z-[200] bg-neutral-900/95 backdrop-blur-md border border-white/10 rounded-lg shadow-xl overflow-hidden min-w-[200px]"
                      >
                        <div className="p-2">
                          <p className="text-white/50 text-xs font-medium px-2 py-1">Subtitles</p>
                          {subtitleLoading && (
                            <div className="flex items-center gap-2 px-2 py-2 text-white/60 text-xs">
                              <Loader2 className="h-3 w-3 animate-spin" />
                              Loading…
                            </div>
                          )}
                          {subtitleError && !subtitleLoading && (
                            <p className="px-2 py-2 text-red-400 text-xs">{subtitleError}</p>
                          )}
                          {!subtitleLoading && subtitleTracks.length === 0 && !subtitleError && (
                            <p className="px-2 py-2 text-white/40 text-xs">No subtitles available</p>
                          )}
                          {subtitleTracks.map((track) => (
                            <button
                              key={track.language}
                              onClick={() => {
                                selectSubtitleTrack(track);
                                setShowSubtitleMenu(false);
                              }}
                              className={cn(
                                'w-full flex items-center justify-between px-2 py-2 text-sm rounded-md transition-colors',
                                selectedTrack?.id === track.id
                                  ? 'bg-white/15 text-white'
                                  : 'text-white/70 hover:bg-white/10 hover:text-white',
                              )}
                            >
                              <span>{track.languageName}</span>
                              {selectedTrack?.id === track.id && (
                                <span className="h-1.5 w-1.5 rounded-full bg-yellow-400" />
                              )}
                            </button>
                          ))}
                        </div>
                      </motion.div>
                    </>
                  )}
                </AnimatePresence>
                {/* Show menu button when CC is on but menu is hidden */}
                {subtitleEnabled && !showSubtitleMenu && (
                  <button
                    onClick={() => setShowSubtitleMenu(true)}
                    className="absolute top-full right-0 mt-0.5 z-[199] flex items-center justify-center min-h-[32px] min-w-[32px] rounded-md bg-black/60 text-white/70 hover:text-white transition-colors"
                    aria-label="Subtitle settings"
                  >
                    <Languages className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>

              {/* Fullscreen button — right after subtitle icon */}
              <button
                onClick={toggleFullscreen}
                className="flex items-center justify-center min-h-[44px] min-w-[44px] text-white/90 hover:text-white transition-colors rounded-lg hover:bg-white/10 -mr-1"
                aria-label={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
              >
                {isFullscreen ? <Minimize className="h-5 w-5" /> : <Maximize className="h-5 w-5" />}
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Fullscreen speaking indicator — shows username + mic icon on right side */}
      {watchPartySync && isFullscreen && (watchPartySync.isPttActive || (watchPartySync.talkingMembers && watchPartySync.talkingMembers.size > 0)) && (
        <FullscreenSpeakingIndicator
          isPttActive={watchPartySync.isPttActive ?? false}
          talkingMembers={watchPartySync.talkingMembers}
          members={watchPartySync.members}
          localUserId={watchPartySync.localUserId}
        />
      )}
    </div>
  );
}

// ─── HLS / Direct Video Player ───────────────────────────────────────────────

function HlsVideoPlayer({
  src,
  poster,
  title,
  startTime = 0,
  onClose,
  onProgressUpdate,
  onCompleted,
  autoPlay,
  onFatalError,
  subtitleUrls,
  subtitleTracks,
  useHls,
  hlsPlaybackId,
  fmp4Blob,
  watchPartySync,
}: VideoPlayerProps & { onFatalError?: () => void }) {
  // Refs
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const mseRef = useRef<ProgressiveMseHandle | null>(null);
  const hideControlsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const progressTrackerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastTapRef = useRef<{ time: number; x: number }>({ time: 0, x: 0 });
  const seekingRef = useRef(false);

  // Whether to use the custom in-memory loader (bypasses blob URLs and XHR)
  const useMemoryLoader = !!hlsPlaybackId;
  // Whether to use MSE-based playback for fMP4 blobs
  const useMse = !!fmp4Blob;

  // State
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  // fullscreen state is provided by useFullscreen hook below (handles webkit for iOS Safari)
  const [pip, setPip] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [showControls, setShowControls] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hoverTime, setHoverTime] = useState<number | null>(null);
  const [hoverPosition, setHoverPosition] = useState(0);
  const [isDraggingProgress, setIsDraggingProgress] = useState(false);
  const [showSpeedMenu, setShowSpeedMenu] = useState(false);
  const [showQualityMenu, setShowQualityMenu] = useState(false);
  const [showVolumeSlider, setShowVolumeSlider] = useState(false);
  const [doubleTapOverlay, setDoubleTapOverlay] = useState<'rewind' | 'forward' | null>(null);
  const [qualityLevels, setQualityLevels] = useState<HlsLevel[]>([]);
  const [currentQuality, setCurrentQuality] = useState(-1); // -1 = auto
  const [subtitlesEnabled, setSubtitlesEnabled] = useState(true);

  // Full screen & wake lock
  const { isFullscreen: fullscreen, toggleFullscreen: toggleFs, ref: fullscreenRef } = useFullscreen();
  const wakeLockRef = useRef<(() => void) | null>(null);

  const isHls = !useMse && (!!useHls || src.includes('.m3u8'));

  // ── Watch Party Sync ──────────────────────────────────────
  // Ref to avoid stale closure in togglePlay/seekTo callbacks
  const wpSyncRef = useRef(watchPartySync);
  wpSyncRef.current = watchPartySync;

  // Lock playback controls for non-host members (play/pause, seek)
  const isMemberLocked = !!(watchPartySync && !watchPartySync.isHost);

  // Track previous pausedBy to detect remote pause/play changes
  const prevPausedByRef = useRef<string | null>(null);

  // React to remote pause/play from watch party
  useEffect(() => {
    if (!watchPartySync) return;
    const video = videoRef.current;
    if (!video) return;

    // Someone paused → pause locally
    if (watchPartySync.pausedBy && !prevPausedByRef.current) {
      video.pause();
    }
    // Pause released → resume locally (only if not the one who paused)
    if (!watchPartySync.pausedBy && prevPausedByRef.current) {
      video.play().catch(() => {});
    }
    prevPausedByRef.current = watchPartySync.pausedBy;
  }, [watchPartySync?.pausedBy]);

  // Periodic sync: host sends current state every 250ms for tighter member sync
  useEffect(() => {
    if (!watchPartySync?.isHost) return;
    const interval = setInterval(() => {
      const video = videoRef.current;
      if (!video) return;
      watchPartySync.onSync(video.currentTime, !video.paused, video.duration || 0);
    }, 250);
    return () => clearInterval(interval);
  }, [watchPartySync?.isHost, watchPartySync?.onSync]);

  // Member sync: correct drift by seeking to host's position.
  //
  // Two mechanisms work together:
  //   1. Effect-based: triggers when hostCurrentTime prop changes (from broadcast)
  //   2. Interval-based: polls every 750ms to catch drift even if broadcasts
  //      are delayed (REST fallback, network issues). This prevents members from
  //      drifting significantly between host sync broadcasts.
  //
  // Sync strategy (tuned for near-identical sync):
  //   - Latency compensation: uses sentAt timestamp from the sync broadcast
  //     to calculate actual one-way network latency, replacing the previous
  //     hardcoded 0.25s guess. This gives accurate compensation on both fast
  //     (LAN) and slow (cellular) connections.
  //   - Threshold: 0.2s — tighter correction window
  //   - Throttle: one correction per 300ms to avoid seek wars
  //   - Emergency: if drift exceeds 1.0s, seek immediately (bypass throttle)
  //   - Speed adjustment: for drift under 0.2s, adjust playback rate
  //     aggressively to catch up/slow down without a jarring seek
  //   - Play/pause matching on every correction
  const lastSeekTimeRef = useRef(0);

  // Helper: calculate dynamic latency offset from sync broadcast's sentAt.
  const calcHlsLatencyOffset = useCallback((sentAt?: number) => {
    if (!sentAt) return 0.25;
    const raw = (Date.now() - sentAt) / 1000;
    return Math.max(0.05, Math.min(raw, 2));
  }, []);

  // Effect-based drift correction (triggers on prop change)
  useEffect(() => {
    if (!watchPartySync || watchPartySync.isHost) return;
    if (watchPartySync.hostCurrentTime === undefined || watchPartySync.hostCurrentTime === null) return;
    const video = videoRef.current;
    if (!video || !video.duration || video.duration === Infinity) return;

    const hostTime = watchPartySync.hostCurrentTime;
    // Compensated target: where the host IS NOW (not where it was when broadcast)
    const latencyOffset = calcHlsLatencyOffset(watchPartySync.lastSyncSentAt);
    const targetTime = Math.min(hostTime + latencyOffset, video.duration - 0.1);
    const drift = Math.abs(video.currentTime - targetTime);
    const SYNC_THRESHOLD = 0.2; // seconds — tighter for near-identical sync
    const EMERGENCY_THRESHOLD = 1.0; // seconds — immediate seek
    const THROTTLE_MS = 300; // ms — minimum between seeks

    if (drift > EMERGENCY_THRESHOLD) {
      // Emergency correction — bypass throttle for large drifts
      video.currentTime = targetTime;
      lastSeekTimeRef.current = Date.now();

      // Also match play/pause state from host
      if (watchPartySync.hostIsPlaying && video.paused) {
        video.play().catch(() => {});
      } else if (!watchPartySync.hostIsPlaying && !video.paused) {
        video.pause();
      }
    } else if (drift > SYNC_THRESHOLD) {
      // Throttle seeks: don't seek more than once per THROTTLE_MS
      const now = Date.now();
      if (now - lastSeekTimeRef.current < THROTTLE_MS) return;
      lastSeekTimeRef.current = now;

      video.currentTime = targetTime;

      // Also match play/pause state from host
      if (watchPartySync.hostIsPlaying && video.paused) {
        video.play().catch(() => {});
      } else if (!watchPartySync.hostIsPlaying && !video.paused) {
        video.pause();
      }
    } else if (drift > 0.08 && watchPartySync.hostIsPlaying && !video.paused) {
      // Small drift while playing — speed up/down to catch up gradually
      // instead of seeking (which causes a visible jump).
      // More aggressive coefficient (0.1 vs previous 0.06) for faster convergence.
      const behind = targetTime - video.currentTime;
      if (behind > 0) {
        video.playbackRate = Math.min(1.15, 1 + behind * 0.1);
      } else {
        video.playbackRate = Math.max(0.85, 1 + behind * 0.1);
      }
    }
  }, [watchPartySync?.hostCurrentTime, watchPartySync?.hostIsPlaying, watchPartySync?.isHost, watchPartySync?.lastSyncSentAt, calcHlsLatencyOffset]);

  // Interval-based drift correction for members (polls every 750ms)
  useEffect(() => {
    if (!watchPartySync || watchPartySync.isHost) return;
    const sync = watchPartySync;

    const interval = setInterval(() => {
      const video = videoRef.current;
      if (!video || !video.duration || video.duration === Infinity) return;
      if (sync.hostCurrentTime === undefined || sync.hostCurrentTime === null) return;
      if (!sync.hostIsPlaying) return; // Only correct drift while playing

      const latencyOffset = calcHlsLatencyOffset(sync.lastSyncSentAt);
      const targetTime = Math.min(sync.hostCurrentTime + latencyOffset, video.duration - 0.1);
      const drift = video.currentTime - targetTime;

      if (Math.abs(drift) > 1.0) {
        // Emergency correction — bypass throttle for large drifts
        video.currentTime = targetTime;
      } else if (Math.abs(drift) > 0.2) {
        const now = Date.now();
        if (now - lastSeekTimeRef.current < 300) return;
        lastSeekTimeRef.current = now;
        video.currentTime = targetTime;
      } else if (Math.abs(drift) > 0.08) {
        // Gradual speed adjustment (stronger coefficients for faster convergence)
        video.playbackRate = drift > 0
          ? Math.max(0.85, 1 + drift * 0.1)
          : Math.min(1.15, 1 + drift * 0.1);
      } else {
        // Close enough — reset to normal speed
        if (video.playbackRate !== 1) video.playbackRate = 1;
      }
    }, 750);

    return () => clearInterval(interval);
  }, [watchPartySync?.isHost, watchPartySync?.hostCurrentTime, watchPartySync?.hostIsPlaying, watchPartySync?.lastSyncSentAt, calcHlsLatencyOffset]);

  // Reset playback rate when not in a watch party or when becoming host
  useEffect(() => {
    if (!watchPartySync || watchPartySync.isHost) {
      const video = videoRef.current;
      if (video && video.playbackRate !== 1) {
        video.playbackRate = 1;
      }
    }
  }, [watchPartySync?.isHost]);

  // Derived
  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;
  const bufferedPercent = duration > 0 ? (buffered / duration) * 100 : 0;
  const volumeIcon = muted || volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2;

  // Controls auto-hide
  const resetHideTimer = useCallback(() => {
    setShowControls(true);
    if (hideControlsTimerRef.current) clearTimeout(hideControlsTimerRef.current);
    hideControlsTimerRef.current = setTimeout(() => {
      if (!showSpeedMenu && !showQualityMenu && !showVolumeSlider) {
        setShowControls(false);
        setShowVolumeSlider(false);
        setShowSpeedMenu(false);
        setShowQualityMenu(false);
      }
    }, 3000);
  }, [showSpeedMenu, showQualityMenu, showVolumeSlider]);

  const handleMouseMove = useCallback(() => {
    resetHideTimer();
  }, [resetHideTimer]);

  // Play / Pause
  const togglePlay = useCallback(() => {
    if (isMemberLocked) return;
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      // User gesture — unmute if browser auto-muted for autoplay policy
      if (video.muted) {
        video.muted = false;
        setMuted(false);
      }
      video.play().catch(() => {});
      // Watch Party: notify play
      wpSyncRef.current?.onPlay(video.currentTime);
    } else {
      video.pause();
      // Watch Party: notify pause
      wpSyncRef.current?.onPause(video.currentTime);
    }
  }, []);

  // Seek
  const seekTo = useCallback((time: number) => {
    if (isMemberLocked) return;
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = Math.max(0, Math.min(time, video.duration || 0));
    // Watch Party: notify seek
    wpSyncRef.current?.onSeek(video.currentTime);
  }, []);

  const seekBy = useCallback((delta: number) => {
    // Read currentTime directly from video ref to avoid stale closure over React state.
    // The state updates on ~250ms timeupdate interval — rapid key presses between
    // updates would seek from a stale position.
    const video = videoRef.current;
    const now = video?.currentTime ?? currentTime;
    seekTo(now + delta);
  }, [currentTime, seekTo]);

  // Volume
  const toggleMute = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
    setMuted(video.muted);
  }, []);

  const changeVolume = useCallback((v: number) => {
    const video = videoRef.current;
    if (!video) return;
    const newVol = Math.max(0, Math.min(1, v));
    video.volume = newVol;
    setVolume(newVol);
    if (newVol > 0 && video.muted) {
      video.muted = false;
      setMuted(false);
    }
  }, []);

  // Toggle subtitle visibility by enabling/disabling text tracks
  const toggleSubtitles = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const tracks = video.textTracks;
    const hasTracks = tracks && tracks.length > 0;
    if (!hasTracks) return;

    const newState = !subtitlesEnabled;
    setSubtitlesEnabled(newState);
    for (let i = 0; i < tracks.length; i++) {
      tracks[i].mode = newState ? 'showing' : 'hidden';
    }
  }, [subtitlesEnabled]);

  // Fullscreen — delegated to useFullscreen hook (handles webkit for iOS Safari)

  // PiP
  const togglePiP = useCallback(async () => {
    const video = videoRef.current;
    if (!video || !document.pictureInPictureEnabled) return;
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else {
        await video.requestPictureInPicture();
      }
    } catch {
      // PiP not supported
    }
  }, []);

  // Playback Speed
  const changePlaybackRate = useCallback((rate: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.playbackRate = rate;
    setPlaybackRate(rate);
    setShowSpeedMenu(false);
  }, []);

  // Quality
  const changeQuality = useCallback(
    (index: number) => {
      const hls = hlsRef.current;
      if (!hls) return;
      hls.currentLevel = index;
      setCurrentQuality(index);
      setShowQualityMenu(false);
    },
    [],
  );

  // Progress bar mouse handlers
  const handleProgressMouseEnter = useCallback(() => {
    setIsDraggingProgress(true);
  }, []);

  const handleProgressMouseMove = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
      const percent = x / rect.width;
      setHoverTime(percent * duration);
      setHoverPosition(percent * 100);
    },
    [duration],
  );

  const handleProgressMouseLeave = useCallback(() => {
    setIsDraggingProgress(false);
    setHoverTime(null);
  }, []);

  const handleProgressClick = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      if (isMemberLocked) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
      const percent = x / rect.width;
      seekTo(percent * duration);
    },
    [duration, seekTo, isMemberLocked],
  );

  // Double-tap
  const handleTap = useCallback(
    (e: ReactTouchEvent<HTMLDivElement> | ReactMouseEvent<HTMLDivElement>) => {
      const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
      const now = Date.now();
      const last = lastTapRef.current;

      if (now - last.time < 300 && Math.abs(clientX - last.x) < 100) {
        // Double-tap detected — block for members
        if (isMemberLocked) {
          lastTapRef.current = { time: 0, x: 0 };
          return;
        }
        const screenWidth = window.innerWidth;
        const isLeftSide = clientX < screenWidth * 0.4;

        if (isLeftSide) {
          seekBy(-10);
          setDoubleTapOverlay('rewind');
        } else {
          seekBy(10);
          setDoubleTapOverlay('forward');
        }
        setTimeout(() => setDoubleTapOverlay(null), 600);

        lastTapRef.current = { time: 0, x: 0 };
      } else {
        lastTapRef.current = { time: now, x: clientX };
      }
    },
    [seekBy, isMemberLocked],
  );

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      switch (e.key) {
        case ' ':
        case 'k':
          if (isMemberLocked) return;
          e.preventDefault();
          togglePlay();
          break;
        case 'ArrowLeft':
          if (isMemberLocked) return;
          e.preventDefault();
          seekBy(-10);
          break;
        case 'ArrowRight':
          if (isMemberLocked) return;
          e.preventDefault();
          seekBy(10);
          break;
        case 'ArrowUp':
          e.preventDefault();
          changeVolume(volume + 0.1);
          break;
        case 'ArrowDown':
          e.preventDefault();
          changeVolume(volume - 0.1);
          break;
        case 'f':
          e.preventDefault();
          toggleFs();
          break;
        case 'm':
          e.preventDefault();
          toggleMute();
          break;
        case 'Escape':
          if (document.fullscreenElement || (document as unknown as Record<string, Element | null>).webkitFullscreenElement) {
            document.exitFullscreen?.().catch(() => {});
          } else {
            onClose();
          }
          break;
      }
      resetHideTimer();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [togglePlay, seekBy, changeVolume, toggleFs, toggleMute, onClose, resetHideTimer, volume, isMemberLocked]);

  // Fullscreen change listener — delegated to useFullscreen hook

  // PiP change listener
  useEffect(() => {
    const handlePiPChange = () => {
      setPip(!!document.pictureInPictureElement);
    };
    document.addEventListener('leavepictureinpicture', handlePiPChange);
    document.addEventListener('enterpictureinpicture', handlePiPChange);
    return () => {
      document.removeEventListener('leavepictureinpicture', handlePiPChange);
      document.removeEventListener('enterpictureinpicture', handlePiPChange);
    };
  }, []);

  // Video event handlers
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const onPlay = () => {
      setPlaying(true);
      console.log(`[SV Player] PLAY — currentTime=${video.currentTime.toFixed(3)}s, duration=${video.duration?.toFixed(3)}s`);
    };
    const onPause = () => {
      setPlaying(false);
      console.log(`[SV Player] PAUSE — currentTime=${video.currentTime.toFixed(3)}s`);
    };
    const onTimeUpdate = () => {
      if (!seekingRef.current) {
        setCurrentTime(video.currentTime);
      }
    };
    const onDurationChange = () => {
      setDuration(video.duration || 0);
      console.log(`[SV Player] DURATION_CHANGE — duration=${video.duration?.toFixed(3)}s`);
    };
    const onProgress = () => {
      if (video.buffered.length > 0) {
        setBuffered(video.buffered.end(video.buffered.length - 1));
      }
    };
    const onWaiting = () => {
      setLoading(true);
      console.warn(
        `[SV Player] WAITING (buffer stall) — currentTime=${video.currentTime.toFixed(3)}s, ` +
        `buffered=${video.buffered.length > 0 ? video.buffered.end(video.buffered.length - 1).toFixed(3) : 'none'}s, ` +
        `duration=${video.duration?.toFixed(3)}s`,
      );
    };
    const onCanPlay = () => setLoading(false);
    const onError = () => {
      const videoEl = videoRef.current;
      const mediaErr = videoEl?.error;
      // Log detailed error info for diagnostics
      if (mediaErr) {
        const errorNames: Record<number, string> = {
          1: 'MEDIA_ERR_ABORTED',
          2: 'MEDIA_ERR_NETWORK',
          3: 'MEDIA_ERR_DECODE',
          4: 'MEDIA_ERR_SRC_NOT_SUPPORTED',
        };
        console.error(
          `[SV Player] Video error: code=${mediaErr.code} (${errorNames[mediaErr.code] || 'UNKNOWN'}), ` +
          `message='${mediaErr.message || 'N/A'}', ` +
          `currentTime=${video.currentTime.toFixed(3)}s, src=${video.src.substring(0, 60)}...`,
        );
      }
      setError('Failed to load video. Please check the source and try again.');
      setLoading(false);
    };
    const onVolumeChange = () => {
      setVolume(video.volume);
      setMuted(video.muted);
    };
    const onEnded = () => {
      console.log(`[SV Player] ENDED — duration=${video.duration?.toFixed(3)}s`);
      if (onCompleted) {
        onCompleted();
      }
    };
    const onStalled = () => {
      console.warn(`[SV Player] STALLED — data transfer stalled at currentTime=${video.currentTime.toFixed(3)}s`);
    };
    const onSuspend = () => {
      console.log(`[SV Player] SUSPEND — media download suspended at currentTime=${video.currentTime.toFixed(3)}s`);
    };
    const onEmptied = () => {
      console.warn(`[SV Player] EMPTIED — media resource emptied`);
    };

    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('timeupdate', onTimeUpdate);
    video.addEventListener('durationchange', onDurationChange);
    video.addEventListener('progress', onProgress);
    video.addEventListener('waiting', onWaiting);
    video.addEventListener('canplay', onCanPlay);
    video.addEventListener('error', onError);
    video.addEventListener('volumechange', onVolumeChange);
    video.addEventListener('ended', onEnded);
    video.addEventListener('stalled', onStalled);
    video.addEventListener('suspend', onSuspend);
    video.addEventListener('emptied', onEmptied);

    return () => {
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('timeupdate', onTimeUpdate);
      video.removeEventListener('durationchange', onDurationChange);
      video.removeEventListener('progress', onProgress);
      video.removeEventListener('waiting', onWaiting);
      video.removeEventListener('canplay', onCanPlay);
      video.removeEventListener('error', onError);
      video.removeEventListener('volumechange', onVolumeChange);
      video.removeEventListener('ended', onEnded);
      video.removeEventListener('stalled', onStalled);
      video.removeEventListener('suspend', onSuspend);
      video.removeEventListener('emptied', onEmptied);
    };
  }, [onCompleted]);

  // Shared HLS config — single source of truth for all HLS instances
  const createHlsInstance = useCallback(
    (video: HTMLVideoElement, onManifestParsed: (hls: Hls, data: Hls.ManifestParsedData) => void, onError: (hls: Hls, data: Hls.ErrorData) => void): Hls | null => {
      if (!Hls.isSupported()) return null;

      let hlsConfig: Hls.Config;

      if (useMemoryLoader) {
        // Download playback: use custom in-memory loader — no XHR, no blob URLs.
        // Segment data is extracted lazily from the Blob via blob.slice().
        // Delivered instantly — MSE's SourceBuffer provides natural backpressure
        // via its async update queue.
        hlsConfig = {
          enableWorker: true, // Must be enabled — worker demuxes in a separate thread,
                             // keeping audio/video PES extraction in sync. Disabling it
                             // causes A/V desync because main-thread demuxing competes
                             // with React re-renders, delaying SourceBuffer appends.
          lowLatencyMode: false,
          backBufferLength: 90,
          startLevel: -1,
          maxBufferLength: 60,
          maxMaxBufferLength: 300,
          maxBufferSize: 120 * 1024 * 1024,
          startFragPrefetch: true,
          loader: MemoryHlsLoader,
          fLoader: MemoryHlsLoader, // Explicit: use custom loader for fragments too
        };
      } else {
        // Streaming: use standard XHR loader with CDN proxy
        hlsConfig = {
          enableWorker: true,
          lowLatencyMode: false,
          backBufferLength: 90,
          startLevel: -1,
          maxBufferLength: 30,
          maxMaxBufferLength: 60,
          xhrSetup: (xhr, url) => {
            // Don't proxy blob: URLs — they're local (fake m3u8 segments)
            if (url.startsWith('blob:')) {
              xhr.open('GET', url, true);
              return;
            }
            let refererHint = '';
            try {
              const parsedUrl = new URL(url);
              refererHint = parsedUrl.origin + '/';
            } catch {
              // URL parsing failed — no referer hint
            }
            let proxyUrl = `/api/stream/proxy?url=${encodeURIComponent(url)}`;
            if (refererHint) {
              proxyUrl += `&referer=${encodeURIComponent(refererHint)}`;
            }
            xhr.open('GET', proxyUrl, true);
          },
        };
      }

      const hls = new Hls(hlsConfig);

      // ── Comprehensive HLS.js event logging for offline playback diagnostics ──
      // These logs help diagnose freezing and A/V desync. All prefixed with [SV HLS].
      if (useMemoryLoader) {
        // Manifest events
        hls.on(Hls.Events.MANIFEST_PARSED, (_e, data) => {
          console.log(
            `[SV HLS] MANIFEST_PARSED: ${data.levels.length} levels, ` +
            `first level: ${data.levels[0]?.height}p@${data.levels[0]?.bitrate}bps, ` +
            `audio: ${data.audio ? data.audio.length : 0} tracks`,
          );
        });

        // Fragment loading events
        hls.on(Hls.Events.FRAG_LOADED, (_e, data) => {
          const frag = data.frag;
          console.log(
            `[SV HLS] FRAG_LOADED: sn=${frag.sn}, level=${frag.level}, ` +
            `duration=${frag.duration.toFixed(3)}s, ` +
            `start=${frag.start.toFixed(3)}s, ` +
            `loaded=${data.fragStats?.loaded || '?'} bytes, ` +
            `loading=${data.networkDetails ? 'network' : 'memory'}`,
          );
        });

        hls.on(Hls.Events.FRAG_LOAD_EMERGENCY_ABORTED, (_e, data) => {
          console.warn(`[SV HLS] FRAG_LOAD_EMERGENCY_ABORTED: frag sn=${data.frag.sn}`);
        });

        // Fragment parsing events — these fire when TS is demuxed
        hls.on(Hls.Events.FRAG_PARSING_INIT_SEGMENT, (_e, data) => {
          console.log(
            `[SV HLS] FRAG_PARSING_INIT_SEGMENT: tracks=${Object.keys(data.tracks).join(',')}, ` +
            `id=${data.id}, frag=${data.frag?.sn}`,
          );
        });

        hls.on(Hls.Events.FRAG_PARSING_DATA, (_e, data) => {
          console.log(
            `[SV HLS] FRAG_PARSING_DATA: type=${data.type}, frag=${data.frag?.sn}, ` +
            `start=${data.startPTS?.toFixed(3)}s, end=${data.endPTS?.toFixed(3)}s`,
          );
        });

        // Buffer events — critical for diagnosing freezing
        hls.on(Hls.Events.BUFFER_APPENDED, (_e, data) => {
          console.log(
            `[SV HLS] BUFFER_APPENDED: type=${data.type}, ` +
            `chunkMeta=${data.chunkMeta?.sn || '?'}, ` +
            `timeRange=${data.timeRanges ? 'available' : 'none'}`,
          );
        });

        hls.on(Hls.Events.BUFFER_CODECS, (_e, data) => {
          console.log(
            `[SV HLS] BUFFER_CODECS: video=${data.videoCodec || 'none'}, audio=${data.audioCodec || 'none'}`,
          );
        });

        hls.on(Hls.Events.BUFFER_CREATED, (_e, data) => {
          const tracks = data.tracks;
          const trackInfo = Object.entries(tracks).map(
            ([type, t]: [string, unknown]) => {
              const track = t as { codec?: string; container?: string };
              return `${type}=${track.codec || '?'}`;
            },
          ).join(', ');
          console.log(`[SV HLS] BUFFER_CREATED: ${trackInfo}`);
        });

        hls.on(Hls.Events.BUFFER_FLUSHED, (_e, data) => {
          console.log(`[SV HLS] BUFFER_FLUSHED: type=${data.type}, startOffset=${data.startOffset}, endOffset=${data.endOffset}`);
        });

        // Stall / buffer state events
        hls.on(Hls.Events.FRAG_BUFFERED, (_e, data) => {
          const frag = data.frag;
          const stats = data.stats;
          console.log(
            `[SV HLS] FRAG_BUFFERED: sn=${frag.sn}, duration=${frag.duration.toFixed(3)}s, ` +
            `buffered=${stats?.buffered || 0}, ` +
            `total=${stats?.total || 0}`,
          );
        });

        // Key loading
        hls.on(Hls.Events.KEY_LOADED, (_e, data) => {
          console.log(`[SV HLS] KEY_LOADED: frag=${data.frag?.sn}`);
        });

        // Level switching
        hls.on(Hls.Events.LEVEL_SWITCHED, (_e, data) => {
          console.log(`[SV HLS] LEVEL_SWITCHED: level=${data.level}`);
        });
      }

      hls.on(Hls.Events.MANIFEST_PARSED, (_event, data) => onManifestParsed(hls, data));
      hls.on(Hls.Events.ERROR, (_event, data) => {
        // Always log ALL HLS.js errors — both fatal and non-fatal
        console.error(
          `[SV HLS] ERROR: type=${data.type}, details=${data.details}, fatal=${data.fatal}, ` +
          `reason=${data.reason || 'N/A'}` +
          (data.response ? `, response={code=${data.response.code}, text='${data.response.text}'}` : '') +
          (data.error ? `, error=${data.error.message || data.error}` : ''),
        );
        if (data.fatal) {
          console.error(`[SV HLS] ★★★ FATAL ERROR — this is the show-stopper ★★★`);
        }
        onError(hls, data);
      });

      hls.loadSource(src);
      hls.attachMedia(video);

      console.log(
        `[SV HLS] Instance created: useMemoryLoader=${useMemoryLoader}, src=${src.substring(0, 80)}...`,
        `enableWorker=${hlsConfig.enableWorker}, maxBufferLength=${hlsConfig.maxBufferLength}, ` +
        `maxMaxBufferLength=${hlsConfig.maxMaxBufferLength}`,
      );
      return hls;
    },
    [src, useMemoryLoader],
  );

  // Retry handler
  // eslint-disable-next-line react-hooks/preserve-manual-memoization
  const handleRetry = useCallback(() => {
    setError(null);
    setLoading(true);
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }
    const video = videoRef.current;
    if (!video) return;

    if (isHls) {
      const hls = createHlsInstance(video, (h, data) => {
        setLoading(false);
        // Restore quality levels
        const levels = data.levels.map((level) => ({
          height: level.height,
          width: level.width,
          bitrate: level.bitrate,
          name: level.name,
        }));
        setQualityLevels(levels);
        if (data.levels.length > 0) {
          h.currentLevel = data.levels.length - 1;
          setCurrentQuality(data.levels.length - 1);
        }
        video.volume = 1;
        video.muted = false;
        video.play().catch(() => {
          video.muted = true;
          setMuted(true);
          video.play().catch(() => {});
        });
      }, (h, data) => {
        // Non-fatal errors: ignore — they're typically transient demuxer quirks
        // that HLS.js handles internally. Calling recoverMediaError() here was
        // the root cause of the "video freezes every few seconds" bug: each call
        // resets the entire MSE pipeline (removes SourceBuffers, recreates them,
        // re-seeks), and when these cascade (81+ times), the player is constantly
        // resetting → freeze-loop. Only intervene on fatal errors.
        if (!data.fatal) return;

        if (data.fatal) {
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            h.recoverMediaError();
          } else if (onFatalError) {
            onFatalError();
          } else {
            setError('Failed to load stream. Please try again.');
            h.destroy();
          }
        }
      });
      if (hls) hlsRef.current = hls;
    } else {
      video.src = src;
      video.load();
      video.volume = 1;
      video.muted = false;
      video.play().catch(() => {
        video.muted = true;
        setMuted(true);
        video.play().catch(() => {});
      });
    }
  }, [isHls, createHlsInstance, onFatalError]);

  // HLS / Video source setup
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    // Defer state resets to avoid synchronous setState in effect body
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) {
        setError(null);
        setLoading(true);
      }
    });

    // Stable handler — defined once, attached once, cleaned up once
    const handleLoadedMetadata = () => {
      setLoading(false);
      if (startTime > 0) {
        video.currentTime = startTime;
      }
      if (autoPlay) {
        video.volume = 1;
        video.muted = false;
        video.play().catch(() => {
          video.muted = true;
          setMuted(true);
          video.play().catch(() => {});
        });
      }
    };

    // For downloaded blob content, wait for 'canplaythrough' instead of 'loadedmetadata'.
    // 'loadedmetadata' fires after parsing the moov box (track info), but the
    // decoder hasn't decoded the first frame yet. 'canplay' fires after the first
    // frame is decoded, but the decoder may still need to buffer more frames for
    // smooth playback. 'canplaythrough' fires when the browser estimates it can
    // play the entire resource without stopping — this eliminates the initial
    // freeze that occurs when the decoder hasn't fully primed its pipeline.
    const handleCanPlay = () => {
      video.removeEventListener('canplaythrough', handleCanPlay);
      video.removeEventListener('canplay', handleCanPlay); // safety cleanup
      setLoading(false);
      if (startTime > 0) {
        video.currentTime = startTime;
      }
      if (autoPlay) {
        // For blob URLs (downloaded fMP4 content), add a brief delay to let
        // the decoder render the first video frame before starting playback.
        // Without this delay, the video appears frozen for ~0.5s because the
        // decoder pipeline hasn't fully primed — the first frame is decoded
        // but not yet rendered to the screen when play() is called.
        const playDelay = src.startsWith('blob:') ? 200 : 0;
        setTimeout(() => {
          video.volume = 1;
          video.muted = false;
          video.play().catch(() => {
            video.muted = true;
            setMuted(true);
            video.play().catch(() => {});
          });
        }, playDelay);
      }
    };

    const setupHls = () => {
      if (Hls.isSupported()) {
        const hls = createHlsInstance(
          video,
          (h, data) => {
            setLoading(false);
            const levels = data.levels.map((level) => ({
              height: level.height,
              width: level.width,
              bitrate: level.bitrate,
              name: level.name,
            }));
            setQualityLevels(levels);

            // Default to highest quality (last level = highest bitrate)
            if (data.levels.length > 0) {
              h.currentLevel = data.levels.length - 1;
              setCurrentQuality(data.levels.length - 1);
            }

            if (startTime > 0) {
              video.currentTime = startTime;
            }
            if (autoPlay) {
              video.volume = 1;
              video.muted = false;
              video.play().catch(() => {
                // Autoplay with audio blocked — try muted, then unmute on next interaction
                video.muted = true;
                setMuted(true);
                video.play().catch(() => {});
              });
            }
          },
          (h, data) => {
            // Non-fatal errors: ignore — they're typically transient demuxer quirks
            // (e.g., internalException from TS timestamp discontinuity). Calling
            // recoverMediaError() on each one was causing a cascade of pipeline
            // resets that froze the video. HLS.js handles non-fatal errors
            // internally; we only need to intervene on fatal ones.
            if (!data.fatal) return;

            if (data.fatal) {
              switch (data.type) {
                case Hls.ErrorTypes.NETWORK_ERROR:
                  // 403 from CDN proxy — auto-fallback to iframe if available
                  if (data.response?.code === 403 || data.details === 'manifestLoadError') {
                    if (onFatalError) {
                      onFatalError();
                      return;
                    }
                  }
                  // Try recovering once for other network errors
                  h.startLoad();
                  break;
                case Hls.ErrorTypes.MEDIA_ERROR:
                  h.recoverMediaError();
                  break;
                default:
                  if (onFatalError) {
                    onFatalError();
                  } else {
                    setError('A fatal streaming error occurred. Please try again.');
                  }
                  h.destroy();
                  break;
              }
            }
          },
        );
        if (hls) hlsRef.current = hls;
        else if (!cancelled) setError('HLS is not supported in this browser.');
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        // Native HLS support (Safari)
        video.src = src;
        video.addEventListener('loadedmetadata', handleLoadedMetadata);
      } else {
        setError('HLS is not supported in this browser.');
      }
    };

    const setupDirect = () => {
      video.preload = 'auto'; // Hint browser to start decoding immediately
      video.src = src;
      // For blob URLs (downloaded content), wait for 'canplaythrough' to avoid
      // initial freeze — the decoder needs multiple frames buffered for smooth
      // playback. 'canplaythrough' fires when the browser has enough data to
      // play without stalling. We also add a 'canplay' fallback with a longer
      // delay, in case 'canplaythrough' takes too long for large files.
      const isBlobSrc = src.startsWith('blob:');
      if (isBlobSrc) {
        video.addEventListener('canplaythrough', handleCanPlay);
        // Fallback: if canplaythrough doesn't fire within 3 seconds, use canplay
        const canplayFallback = () => {
          video.removeEventListener('canplay', canplayFallback);
          // Longer delay for canplay (vs canplaythrough) — the decoder needs
          // more time to buffer frames since canplay fires earlier. 300ms
          // ensures the pipeline is fully primed before playback starts.
          setTimeout(handleCanPlay, 300);
        };
        video.addEventListener('canplay', canplayFallback);
        // Safety timeout: force play after 5 seconds regardless
        setTimeout(() => {
          video.removeEventListener('canplaythrough', handleCanPlay);
          video.removeEventListener('canplay', canplayFallback);
          if (loading) {
            setLoading(false);
            if (autoPlay) {
              video.volume = 1;
              video.muted = false;
              video.play().catch(() => {
                video.muted = true;
                setMuted(true);
                video.play().catch(() => {});
              });
            }
          }
        }, 5000);
      } else {
        video.addEventListener('loadedmetadata', handleLoadedMetadata);
      }
    };

    const setupMse = async () => {
      if (!fmp4Blob) return;
      try {
        // Try cached segments first (skips fMP4 re-parsing, preserves
        // mux.js's original video+audio grouping per data segment)
        const cached = hlsPlaybackId ? getCachedSegments(hlsPlaybackId) : null;

        let initSeg: Uint8Array;
        let dataSegs: Uint8Array[];

        if (cached) {
          console.log(`[SV Player] Using cached segments for progressive MSE`);
          initSeg = cached.initSegment;
          dataSegs = cached.dataSegments;
        } else {
          console.log(`[SV Player] No cached segments — parsing fMP4 blob for progressive MSE`);
          const arrayBuffer = await fmp4Blob.arrayBuffer();
          const rawData = new Uint8Array(arrayBuffer);
          const parsed = parseFmp4Fragments(rawData);

          if (!parsed.initSegment || parsed.initSegment.byteLength === 0) {
            throw new Error('fMP4 parsing failed — no init segment found');
          }

          initSeg = parsed.initSegment;
          dataSegs = combineFragmentPairs(parsed.fragments);
        }

        // Progressive MSE: appends initial batch, caller drives further
        // appending via timeupdate + interval backup. Avoids QuotaExceededError on large files.
        const handle = await setupFmp4MseProgressive(video, initSeg, dataSegs);
        mseRef.current = handle;

        // ── Progressive buffer management ─────────────────────────────
        // Keeps ~60s ahead of playback, evicts data >120s behind.
        // Uses BOTH timeupdate events AND a setInterval backup.
        // The interval is critical: when the video stalls, timeupdate stops
        // firing, which previously caused a deadlock (no more segments appended
        // → video stays stalled permanently). The interval ensures buffer
        // management continues even during stalls.
        const BUFFER_AHEAD_TARGET = 60;   // seconds to keep ahead
        const BUFFER_BEHIND_MAX = 120;    // seconds before evicting old data
        const APPEND_BATCH = 5;           // segments per append cycle
        let bufferManageInProgress = false;

        const manageBuffer = async () => {
          if (bufferManageInProgress || !mseRef.current || handle.isComplete) return;
          bufferManageInProgress = true;

          try {
            const currentT = video.currentTime;
            const ahead = handle.getBufferedAhead(currentT);
            const behind = handle.getBufferedBehind(currentT);

            // Append more segments if buffer ahead is running low
            if (ahead < BUFFER_AHEAD_TARGET && handle.appendedCount < handle.totalSegments) {
              await handle.appendNext(APPEND_BATCH);
            }

            // Evict old data to free SourceBuffer quota
            if (behind > BUFFER_BEHIND_MAX) {
              await handle.evictBefore(currentT - 30); // keep 30s safety margin
            }

            // If quota was hit during append, evict aggressively and retry
            if (ahead < 10 && handle.appendedCount < handle.totalSegments) {
              await handle.evictBefore(currentT - 10);
              await handle.appendNext(APPEND_BATCH);
            }
          } catch {
            // Non-critical — playback continues with existing buffer
          } finally {
            bufferManageInProgress = false;
          }
        };

        // Primary: timeupdate drives buffer management during normal playback
        video.addEventListener('timeupdate', manageBuffer);

        // Backup: interval ensures buffer management continues even during stalls
        // (timeupdate stops firing when video is paused/waiting → deadlock without this)
        const bufferInterval = setInterval(() => {
          if (!mseRef.current || handle.isComplete) {
            clearInterval(bufferInterval);
            return;
          }
          manageBuffer();
        }, 2000);

        // Store handlers for cleanup
        (video as HTMLVideoElement & { _svMseBufferHandler?: () => void })._svMseBufferHandler = manageBuffer;
        (video as HTMLVideoElement & { _svMseBufferInterval?: ReturnType<typeof setInterval> })._svMseBufferInterval = bufferInterval;

        // ── MSE Stall Recovery ──────────────────────────────────────
        // Chrome sometimes stalls at currentTime=X despite having buffer ahead.
        // This happens when the decoder encounters a minor discontinuity in
        // the fMP4 stream. A small seek (0.1s forward) forces Chrome to
        // re-initialize the decoder from the next keyframe.
        //
        // Also appends more segments on stall — this fixes the case where
        // the buffer runs out at the boundary of the initial batch.
        let stallCount = 0;
        const MAX_STALL_RECOVERIES = 5;
        let lastStallTime = 0;

        const onMseStall = () => {
          const now = Date.now();
          // Debounce: ignore stall events within 2 seconds of each other
          if (now - lastStallTime < 2000) return;
          lastStallTime = now;

          const buffered = video.buffered;
          if (buffered.length === 0) return;
          const bufferedEnd = buffered.end(buffered.length - 1);
          const currentT = video.currentTime;
          const ahead = bufferedEnd - currentT;

          // If buffer is low, append more segments immediately (fixes deadlock
          // at initial batch boundary where timeupdate can't fire)
          if (ahead < 10 && handle.appendedCount < handle.totalSegments) {
            console.warn(
              `[SV MSE] Stall with low buffer (ahead=${ahead.toFixed(1)}s) — appending more segments`,
            );
            manageBuffer();
            return; // Don't seek — just wait for new buffer
          }

          // Only recover if there's adequate buffer ahead (>5s) and we're stalled
          if (ahead < 5) return;
          if (stallCount >= MAX_STALL_RECOVERIES) return;

          stallCount++;
          console.warn(
            `[SV MSE] Stall recovery #${stallCount}: currentTime=${currentT.toFixed(3)}s, ` +
            `buffered=${bufferedEnd.toFixed(3)}s — nudging forward 0.1s`,
          );

          // Small seek forward to nudge the decoder
          const targetTime = currentT + 0.1;
          if (targetTime < bufferedEnd) {
            video.currentTime = targetTime;
            video.play().catch(() => {});
          }
        };

        video.addEventListener('waiting', onMseStall);
        (video as HTMLVideoElement & { _svMseStallHandler?: () => void })._svMseStallHandler = onMseStall;

        if (!cancelled) {
          setLoading(false);
          if (startTime > 0) {
            video.currentTime = startTime;
          }
          if (autoPlay) {
            video.volume = 1;
            video.muted = false;
            video.play().catch(() => {
              video.muted = true;
              setMuted(true);
              video.play().catch(() => {});
            });
          }
        }
      } catch (err) {
        // MSE failed — fall back to blob URL from fmp4Blob
        console.error(`[SV Player] Progressive MSE setup FAILED, falling back to blob URL:`, err);
        const blobUrl = URL.createObjectURL(fmp4Blob);
        video.src = blobUrl;
        video.addEventListener('loadedmetadata', handleLoadedMetadata);
      }
    };

    if (useMse) {
      setupMse();
    } else if (isHls) {
      setupHls();
    } else {
      setupDirect();
    }

    return () => {
      cancelled = true;
      // Remove progressive MSE buffer management handler
      const bufferHandler = (video as HTMLVideoElement & { _svMseBufferHandler?: () => void })._svMseBufferHandler;
      if (bufferHandler) {
        video.removeEventListener('timeupdate', bufferHandler);
        delete (video as HTMLVideoElement & { _svMseBufferHandler?: () => void })._svMseBufferHandler;
      }
      // Clear backup buffer management interval
      const bufferInterval = (video as HTMLVideoElement & { _svMseBufferInterval?: ReturnType<typeof setInterval> })._svMseBufferInterval;
      if (bufferInterval) {
        clearInterval(bufferInterval);
        delete (video as HTMLVideoElement & { _svMseBufferInterval?: ReturnType<typeof setInterval> })._svMseBufferInterval;
      }
      const stallHandler = (video as HTMLVideoElement & { _svMseStallHandler?: () => void })._svMseStallHandler;
      if (stallHandler) {
        video.removeEventListener('waiting', stallHandler);
        delete (video as HTMLVideoElement & { _svMseStallHandler?: () => void })._svMseStallHandler;
      }
      video.removeEventListener('loadedmetadata', handleLoadedMetadata);
      video.removeEventListener('canplay', handleCanPlay);
      video.removeEventListener('canplaythrough', handleCanPlay);
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
      if (mseRef.current) {
        mseRef.current.cleanup();
        mseRef.current = null;
      }
      if (progressTrackerRef.current) {
        clearInterval(progressTrackerRef.current);
        progressTrackerRef.current = null;
      }
    };
  }, [src, startTime, autoPlay, isHls, useMse, fmp4Blob]);

  // Progress tracking (every 5s)
  useEffect(() => {
    if (!onProgressUpdate) return;

    progressTrackerRef.current = setInterval(() => {
      const video = videoRef.current;
      if (video && !video.paused && video.duration > 0) {
        onProgressUpdate(video.currentTime, video.duration);
      }
    }, 5000);

    return () => {
      if (progressTrackerRef.current) {
        clearInterval(progressTrackerRef.current);
      }
    };
  }, [onProgressUpdate]);

  // ── Periodic A/V sync diagnostics (every 10s when playing via MemoryHlsLoader) ──
  // Logs buffer state, video position, and HLS.js internal state to help
  // diagnose freezing and A/V desync. Only runs for memory-loaded content.
  useEffect(() => {
    if (!useMemoryLoader) return;

    const diagnosticInterval = setInterval(() => {
      const video = videoRef.current;
      const hls = hlsRef.current;
      if (!video || video.paused) return;

      const bufferInfo = [];
      for (let i = 0; i < video.buffered.length; i++) {
        bufferInfo.push(
          `[${video.buffered.start(i).toFixed(2)}-${video.buffered.end(i).toFixed(2)}]`,
        );
      }

      const audioBufferInfo = [];
      // Try to get audio buffer info from MediaSource
      try {
        const mediaSource = (video as HTMLVideoElement & { srcObject?: MediaSource }).srcObject;
        if (mediaSource && 'sourceBuffers' in mediaSource) {
          const ms = mediaSource as MediaSource;
          for (let i = 0; i < ms.sourceBuffers.length; i++) {
            const sb = ms.sourceBuffers[i];
            // Type-safe access to buffered ranges
            const ranges: string[] = [];
            for (let j = 0; j < sb.buffered.length; j++) {
              ranges.push(`[${sb.buffered.start(j).toFixed(2)}-${sb.buffered.end(j).toFixed(2)}]`);
            }
            audioBufferInfo.push(`${sb.type.substring(0, 20)}: ${ranges.join(', ')}`);
          }
        }
      } catch {
        // MediaSource not accessible
      }

      console.log(
        `[SV Diagnostic] A/V State: currentTime=${video.currentTime.toFixed(3)}s, ` +
        `duration=${video.duration?.toFixed(3)}s, ` +
        `buffered=${bufferInfo.join(', ') || 'none'}, ` +
        `readyState=${video.readyState} (${['HAVE_NOTHING', 'HAVE_METADATA', 'HAVE_CURRENT_DATA', 'HAVE_FUTURE_DATA', 'HAVE_ENOUGH_DATA'][video.readyState] || '?'}), ` +
        `paused=${video.paused}, ended=${video.ended}, ` +
        `hlsLevel=${hls?.currentLevel ?? '?'}, ` +
        `playbackRate=${video.playbackRate}`,
      );

      if (audioBufferInfo.length > 0) {
        console.log(`[SV Diagnostic] SourceBuffers: ${audioBufferInfo.join(' | ')}`);
      }
    }, 10000);

    return () => clearInterval(diagnosticInterval);
  }, [useMemoryLoader]);

  // Auto-enter fullscreen on play, request wake lock
  useEffect(() => {
    if (playing) {
      // Auto enter fullscreen on mobile
      const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
      const el = fullscreenRef.current as (HTMLElement & { webkitRequestFullscreen?: () => Promise<void> }) | null;
      if (isMobile && el && !document.fullscreenElement && !(document as unknown as Record<string, Element | null>).webkitFullscreenElement) {
        if (el.requestFullscreen) {
          el.requestFullscreen().catch(() => {});
        } else if (el.webkitRequestFullscreen) {
          el.webkitRequestFullscreen().catch(() => {});
        }
      }
      // Request wake lock to prevent screen sleeping
      requestWakeLock().then((release) => {
        wakeLockRef.current = release;
      });
      // Lock orientation to landscape for video
      lockOrientation('landscape').catch(() => {});
    } else {
      // Release wake lock when paused
      if (wakeLockRef.current) {
        wakeLockRef.current();
        wakeLockRef.current = null;
      }
    }
  }, [playing, fullscreenRef]);

  // Cleanup on unmount: release wake lock, unlock orientation, exit fullscreen
  useEffect(() => {
    return () => {
      if (wakeLockRef.current) {
        wakeLockRef.current();
      }
      unlockOrientation();
      // Exit fullscreen when player closes to prevent stuck fullscreen state
      if (document.fullscreenElement || (document as unknown as Record<string, Element | null>).webkitFullscreenElement) {
        document.exitFullscreen?.().catch(() => {});
      }
    };
  }, []);
  useEffect(() => {
    if (!showVolumeSlider) return;
    const timer = setTimeout(() => setShowVolumeSlider(false), 3000);
    return () => clearTimeout(timer);
  }, [showVolumeSlider]);

  // Cleanup hide timer on unmount
  useEffect(() => {
    return () => {
      if (hideControlsTimerRef.current) clearTimeout(hideControlsTimerRef.current);
    };
  }, []);

  // ─── Render ──────────────────────────────────────────────────────────────

  return (
    <div
      ref={(el) => {
        containerRef.current = el;
        (fullscreenRef as React.MutableRefObject<HTMLElement | null>).current = el;
        setPlayerContainerForPtt(el);
      }}
      className="fixed inset-0 z-[100] bg-black select-none-native overflow-hidden immersive-fullscreen"
      onMouseMove={handleMouseMove}
      onMouseLeave={() => {
        if (playing) resetHideTimer();
      }}
      style={{ cursor: showControls || !playing ? 'default' : 'none' }}
    >
      {/* Video Element */}
      <video
        ref={videoRef}
        className="absolute inset-0 h-full w-full object-contain"
        poster={poster}
        playsInline
        onClick={handleTap}
        onTouchStart={handleTap}
        crossOrigin="anonymous"
      >
        {subtitleUrls && subtitleTracks?.map((track) => (
          <track
            key={track.language}
            kind="subtitles"
            src={subtitleUrls[track.language]}
            srcLang={track.language}
            label={track.name || track.language}
            default={track.isDefault || subtitleTracks.length === 1}
          />
        ))}
      </video>

      {/* Loading Spinner */}
      <AnimatePresence>
        {loading && !error && (
          <motion.div
            className="absolute inset-0 flex items-center justify-center pointer-events-none"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            <Loader2 className="h-12 w-12 text-white animate-spin" />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Error Overlay */}
      <AnimatePresence>
        {error && (
          <motion.div
            className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-black/80 z-[110]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <AlertCircle className="h-16 w-16 text-sv-red" />
            <p className="text-white/80 text-sm max-w-md text-center px-4">{error}</p>
            <div className="flex flex-col gap-2.5 items-center">
              <button
                onClick={handleRetry}
                className="flex items-center gap-2 px-6 py-3 rounded-full bg-sv-red hover:bg-sv-red-hover text-white font-medium transition-colors"
              >
                <RotateCcw className="h-4 w-4" />
                Retry
              </button>
              {title && (
                <button
                  onClick={() => {
                    const searchSuffix = mediaType === 'tv' ? 'series' : 'full movie';
                    const q = encodeURIComponent(`${title} ${searchSuffix}`);
                    window.open(`https://www.youtube.com/results?search_query=${q}`, '_blank');
                  }}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg bg-[#FF0000]/15 hover:bg-[#FF0000]/25 text-red-400 hover:text-red-300 text-xs font-medium transition-colors cursor-pointer"
                >
                  <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 fill-current">
                    <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814z"/>
                    <path fill="#fff" d="M9.545 15.568V8.432L15.818 12z"/>
                  </svg>
                  Search on YouTube
                  <ExternalLink className="h-3 w-3" />
                </button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Watch Party pause notification */}
      <AnimatePresence>
        {watchPartySync?.pauseNotification && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="absolute top-4 left-1/2 -translate-x-1/2 z-[120] bg-black/80 backdrop-blur-sm border border-white/10 rounded-xl px-4 py-2 pointer-events-none"
          >
            <p className="text-sm text-white/90 font-medium">
              ⏸ Paused by {watchPartySync.pauseNotification.pausedByName}
            </p>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Fullscreen speaking indicator — shows username + mic icon on right side */}
      {watchPartySync && fullscreen && (watchPartySync.isPttActive || (watchPartySync.talkingMembers && watchPartySync.talkingMembers.size > 0)) && (
        <FullscreenSpeakingIndicator
          isPttActive={watchPartySync.isPttActive ?? false}
          talkingMembers={watchPartySync.talkingMembers}
          members={watchPartySync.members}
          localUserId={watchPartySync.localUserId}
        />
      )}

      {/* Double-tap animated overlay */}
      <AnimatePresence>
        {doubleTapOverlay && !isMemberLocked && (
          <motion.div
            className={cn(
              'absolute top-1/2 -translate-y-1/2 flex items-center gap-2 pointer-events-none z-[105]',
              doubleTapOverlay === 'rewind' ? 'left-[15%]' : 'right-[15%]',
            )}
            initial={{ opacity: 0, scale: 0.5 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 1.3 }}
            transition={{ duration: 0.2 }}
          >
            <div className="flex items-center justify-center w-16 h-16 md:w-20 md:h-20 rounded-full bg-black/50 backdrop-blur-sm">
              {doubleTapOverlay === 'rewind' ? (
                <SkipBack className="h-8 w-8 md:h-10 md:w-10 text-white" />
              ) : (
                <SkipForward className="h-8 w-8 md:h-10 md:w-10 text-white" />
              )}
            </div>
            <span className="text-white text-sm md:text-base font-medium bg-black/50 backdrop-blur-sm px-3 py-1.5 rounded-full">
              {doubleTapOverlay === 'rewind' ? '-10s' : '+10s'}
            </span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Controls Overlay */}
      <AnimatePresence>
        {showControls && (
          <motion.div
            className="absolute inset-0 z-[104] flex flex-col justify-between transition-opacity"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.25 }}
            onMouseEnter={() => setShowControls(true)}
          >
            {/* Top gradient bar */}
            <div className="bg-gradient-to-b from-black/60 via-black/30 to-transparent pt-4 pb-12 px-4 md:px-6">
              <div className="flex items-center justify-between">
                {/* Back button */}
                <button
                  onClick={onClose}
                  className="flex items-center gap-2 text-white/90 hover:text-white transition-colors min-h-[44px] min-w-[44px] justify-start rounded-lg hover:bg-white/10"
                  aria-label="Go back"
                >
                  <ArrowLeft className="h-6 w-6" />
                  <span className="text-sm hidden sm:inline">Back</span>
                </button>

                {/* Title */}
                {title && (
                  <h1 className="text-white text-sm md:text-base font-medium truncate max-w-[60%] text-center px-4">
                    {title}
                  </h1>
                )}

                {/* PiP button (top-right) */}
                <button
                  onClick={togglePiP}
                  className="flex items-center justify-center min-h-[44px] min-w-[44px] text-white/70 hover:text-white transition-colors rounded-lg hover:bg-white/10"
                  aria-label="Picture in Picture"
                >
                  <PictureInPicture2 className="h-5 w-5" />
                </button>
              </div>
            </div>

            {/* Center play/pause (visible when paused) */}
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <AnimatePresence>
                {!playing && !loading && !isMemberLocked && (
                  <motion.button
                    className="pointer-events-auto flex items-center justify-center w-20 h-20 md:w-24 md:h-24 rounded-full bg-white/15 backdrop-blur-md hover:bg-white/25 transition-colors"
                    onClick={togglePlay}
                    initial={{ opacity: 0, scale: 0.8 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 1.2 }}
                    transition={{ duration: 0.2 }}
                    aria-label={playing ? 'Pause' : 'Play'}
                  >
                    <Play className="h-10 w-10 md:h-12 md:w-12 text-white ml-1" fill="white" />
                  </motion.button>
                )}
              </AnimatePresence>
            </div>

            {/* Bottom control bar */}
            <div className="bg-gradient-to-t from-black/80 via-black/40 to-transparent pt-12 pb-4 px-3 md:px-6">
              {/* Progress bar */}
              <div
                className={cn(
                  'group relative h-5 flex items-center mb-2',
                  isMemberLocked ? 'pointer-events-none opacity-50 cursor-default' : 'cursor-pointer',
                )}
                onMouseEnter={handleProgressMouseEnter}
                onMouseMove={handleProgressMouseMove}
                onMouseLeave={handleProgressMouseLeave}
                onClick={handleProgressClick}
                role="slider"
                aria-label="Video progress"
                aria-valuenow={Math.round(progress)}
                aria-valuemin={0}
                aria-valuemax={100}
                tabIndex={0}
              >
                {/* Track background */}
                <div className="absolute left-0 right-0 h-1 group-hover:h-1.5 transition-all duration-150 rounded-full bg-white/20">
                  {/* Buffered */}
                  <div
                    className="absolute left-0 top-0 h-full rounded-full bg-white/30 transition-all duration-200"
                    style={{ width: `${bufferedPercent}%` }}
                  />
                  {/* Played */}
                  <div
                    className="absolute left-0 top-0 h-full rounded-full bg-sv-red transition-all duration-100"
                    style={{ width: `${progress}%` }}
                  />
                  {/* Thumb */}
                  <div
                    className="absolute top-1/2 -translate-y-1/2 w-3.5 h-3.5 rounded-full bg-sv-red shadow-md opacity-0 group-hover:opacity-100 transition-opacity duration-150"
                    style={{ left: `calc(${progress}% - 7px)` }}
                  />
                </div>

                {/* Hover time tooltip */}
                <AnimatePresence>
                  {hoverTime !== null && isDraggingProgress && (
                    <motion.div
                      className="absolute -top-8 pointer-events-none z-10"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      style={{ left: `${hoverPosition}%`, transform: 'translateX(-50%)' }}
                    >
                      <div className="bg-black/90 text-white text-[10px] px-2 py-1 rounded whitespace-nowrap">
                        {formatTime(hoverTime)}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

              {/* Controls row */}
              <div className="flex items-center gap-2 md:gap-3">
                {/* Left: Time */}
                <div className="text-xs text-white/80 font-mono whitespace-nowrap">
                  {formatTime(currentTime)}
                  <span className="text-white/40 mx-1">/</span>
                  {formatTime(duration)}
                </div>

                {/* Spacer */}
                <div className="flex-1" />

                {/* Right: Controls */}
                <div className="flex items-center gap-1 md:gap-2">
                  {/* Playback speed — hidden for members */}
                  {!isMemberLocked && <div className="relative">
                    <button
                      onClick={() => {
                        setShowSpeedMenu(!showSpeedMenu);
                        setShowQualityMenu(false);
                      }}
                      className="flex items-center justify-center min-h-[40px] min-w-[40px] text-white/70 hover:text-white transition-colors rounded-lg hover:bg-white/10"
                      aria-label="Playback speed"
                    >
                      <span className="text-xs font-semibold">{playbackRate}x</span>
                    </button>
                    <AnimatePresence>
                      {showSpeedMenu && (
                        <motion.div
                          className="absolute bottom-full right-0 mb-2 bg-[#1a1a1a]/95 backdrop-blur-md border border-white/10 rounded-lg py-1.5 min-w-[100px] shadow-xl"
                          initial={{ opacity: 0, y: 8 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, y: 8 }}
                          transition={{ duration: 0.15 }}
                        >
                          {PLAYBACK_RATES.map((rate) => (
                            <button
                              key={rate}
                              onClick={() => changePlaybackRate(rate)}
                              className={cn(
                                'w-full text-left px-4 py-2 text-sm transition-colors',
                                playbackRate === rate
                                  ? 'text-sv-red font-semibold'
                                  : 'text-white/80 hover:text-white hover:bg-white/10',
                              )}
                            >
                              {rate}x
                            </button>
                          ))}
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>}

                  {/* Quality selector (only for HLS) */}
                  {qualityLevels.length > 0 && (
                    <div className="relative">
                      <button
                        onClick={() => {
                          setShowQualityMenu(!showQualityMenu);
                          setShowSpeedMenu(false);
                        }}
                        className="flex items-center justify-center min-h-[40px] min-w-[40px] text-white/70 hover:text-white transition-colors rounded-lg hover:bg-white/10"
                        aria-label="Video quality"
                      >
                        <span className="text-xs font-semibold flex items-center gap-1">
                          {currentQuality === -1 ? 'Auto' : qualityLabel(qualityLevels[currentQuality]?.height ?? 0)}
                          <ChevronDown className="h-3 w-3" />
                        </span>
                      </button>
                      <AnimatePresence>
                        {showQualityMenu && (
                          <motion.div
                            className="absolute bottom-full right-0 mb-2 bg-[#1a1a1a]/95 backdrop-blur-md border border-white/10 rounded-lg py-1.5 min-w-[100px] shadow-xl"
                            initial={{ opacity: 0, y: 8 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: 8 }}
                            transition={{ duration: 0.15 }}
                          >
                            <button
                              onClick={() => changeQuality(-1)}
                              className={cn(
                                'w-full text-left px-4 py-2 text-sm transition-colors',
                                currentQuality === -1
                                  ? 'text-sv-red font-semibold'
                                  : 'text-white/80 hover:text-white hover:bg-white/10',
                              )}
                            >
                              Auto
                            </button>
                            {qualityLevels
                              .slice()
                              .sort((a, b) => b.height - a.height)
                              .map((level) => {
                                const sortedIndex = qualityLevels.indexOf(level);
                                return (
                                  <button
                                    key={sortedIndex}
                                    onClick={() => changeQuality(sortedIndex)}
                                    className={cn(
                                      'w-full text-left px-4 py-2 text-sm transition-colors',
                                      currentQuality === sortedIndex
                                        ? 'text-sv-red font-semibold'
                                        : 'text-white/80 hover:text-white hover:bg-white/10',
                                    )}
                                  >
                                    {qualityLabel(level.height)}
                                  </button>
                                );
                              })}
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  )}

                  {/* Volume */}
                  <div
                    className="relative flex items-center"
                    onMouseEnter={() => setShowVolumeSlider(true)}
                    onMouseLeave={() => setShowVolumeSlider(false)}
                  >
                    <button
                      onClick={toggleMute}
                      className="flex items-center justify-center min-h-[40px] min-w-[40px] text-white/70 hover:text-white transition-colors rounded-lg hover:bg-white/10"
                      aria-label={muted ? 'Unmute' : 'Mute'}
                    >
                      {volumeIcon && <volumeIcon className="h-5 w-5" />}
                    </button>
                    <AnimatePresence>
                      {showVolumeSlider && (
                        <motion.div
                          className="absolute bottom-full right-0 mb-2 flex items-center gap-2 bg-[#1a1a1a]/95 backdrop-blur-md border border-white/10 rounded-lg py-2.5 px-3 shadow-xl"
                          initial={{ opacity: 0, y: 8, width: 0, padding: 0 }}
                          animate={{ opacity: 1, y: 0, width: 'auto', padding: '0.625rem 0.75rem' }}
                          exit={{ opacity: 0, y: 8, width: 0, padding: 0 }}
                          transition={{ duration: 0.15 }}
                        >
                          <VolumeX className="h-3.5 w-3.5 text-white/50 flex-shrink-0" />
                          <input
                            type="range"
                            min={0}
                            max={1}
                            step={0.01}
                            value={muted ? 0 : volume}
                            onChange={(e) => changeVolume(parseFloat(e.target.value))}
                            className="w-20 md:w-24 accent-sv-red h-1 bg-white/20 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-sv-red"
                            aria-label="Volume"
                          />
                          <Volume2 className="h-3.5 w-3.5 text-white/50 flex-shrink-0" />
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>

                  {/* Subtitles toggle — only show when subtitle tracks exist */}
                  {subtitleTracks && subtitleTracks.length > 0 && (
                    <button
                      onClick={toggleSubtitles}
                      className={cn(
                        'flex items-center justify-center min-h-[40px] min-w-[40px] transition-colors rounded-lg hover:bg-white/10',
                        subtitlesEnabled ? 'text-white' : 'text-white/30',
                      )}
                      aria-label={subtitlesEnabled ? 'Disable subtitles' : 'Enable subtitles'}
                    >
                      <Subtitles className="h-5 w-5" />
                    </button>
                  )}

                  {/* Fullscreen — available to all users */}
                  <button
                    onClick={toggleFs}
                    className="flex items-center justify-center min-h-[40px] min-w-[40px] text-white/70 hover:text-white transition-colors rounded-lg hover:bg-white/10"
                    aria-label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
                  >
                    {fullscreen ? (
                      <Minimize className="h-5 w-5" />
                    ) : (
                      <Maximize className="h-5 w-5" />
                    )}
                  </button>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Click-away dismiss for menus */}
      {(showSpeedMenu || showQualityMenu) && (
        <div
          className="absolute inset-0 z-[103]"
          onClick={() => {
            setShowSpeedMenu(false);
            setShowQualityMenu(false);
          }}
        />
      )}
    </div>
  );
}

// ─── Player Error Boundary ──────────────────────────────────────────────────
// Catches any unhandled exception inside IframeEmbedPlayer or HlsVideoPlayer.
// Without this, a single runtime error crashes the entire React tree.

interface PlayerErrorBoundaryProps {
  children: ReactNode;
  onClose: () => void;
  title?: string;
  mediaType?: 'movie' | 'tv';
}

interface PlayerErrorBoundaryState {
  hasError: boolean;
  errorMessage: string;
  errorStack: string;
  showDetails: boolean;
}

class PlayerErrorBoundary extends Component<PlayerErrorBoundaryProps, PlayerErrorBoundaryState> {
  constructor(props: PlayerErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, errorMessage: '', errorStack: '', showDetails: false };
  }

  static getDerivedStateFromError(error: Error): PlayerErrorBoundaryState {
    return {
      hasError: true,
      errorMessage: error.message || 'Unknown error',
      errorStack: error.stack || '',
      showDetails: false,
    };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[VideoPlayer ErrorBoundary]', error, info.componentStack);
  }

  handleRetry = () => {
    this.setState({ hasError: false, errorMessage: '', errorStack: '', showDetails: false });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="fixed inset-0 z-[100] flex flex-col items-center justify-center gap-4 bg-black/95">
          <AlertCircle className="h-14 w-14 text-sv-red" />
          <p className="text-white/80 text-sm max-w-xs text-center px-4">
            Something went wrong while loading the player.
          </p>
          <div className="flex gap-3">
            <button
              onClick={this.handleRetry}
              className="px-5 py-2.5 rounded-lg bg-white/10 hover:bg-white/20 text-white text-sm font-medium transition-colors cursor-pointer"
            >
              Retry
            </button>
            <button
              onClick={this.props.onClose}
              className="px-5 py-2.5 rounded-lg bg-sv-red hover:bg-sv-red-hover text-white text-sm font-medium transition-colors cursor-pointer"
            >
              Go Back
            </button>
          </div>
          {this.props.title && (
            <button
              onClick={() => {
                const q = encodeURIComponent(`${this.props.title} ${this.props.mediaType === 'tv' ? 'series' : 'full movie'}`);
                window.open(`https://www.youtube.com/results?search_query=${q}`, '_blank');
              }}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-[#FF0000]/15 hover:bg-[#FF0000]/25 text-red-400 hover:text-red-300 text-xs font-medium transition-colors cursor-pointer"
            >
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 fill-current">
                <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814z"/>
                <path fill="#fff" d="M9.545 15.568V8.432L15.818 12z"/>
              </svg>
              Search on YouTube
              <ExternalLink className="h-3 w-3" />
            </button>
          )}
          {/* Collapsible error details for debugging */}
          <button
            onClick={() => this.setState((s) => ({ showDetails: !s.showDetails }))}
            className="text-white/40 text-xs underline underline-offset-2 mt-2 cursor-pointer"
          >
            {this.state.showDetails ? 'Hide' : 'Show'} error details
          </button>
          {this.state.showDetails && (
            <pre className="text-white/50 text-[10px] max-w-md max-h-32 overflow-auto bg-white/5 rounded-lg p-3 mx-4 whitespace-pre-wrap break-all">
              {this.state.errorMessage}\n{this.state.errorStack}
            </pre>
          )}
        </div>
      );
    }
    return this.props.children;
  }
}

// ─── Watch Party PTT Button (floating, always visible in video player) ──────

function getSpeakingNames(
  talkingMembers?: Set<string>,
  members?: { userId: string; displayName: string }[],
  localUserId?: string,
): string {
  if (!talkingMembers || talkingMembers.size === 0) return 'Speaking'
  const names: string[] = []
  talkingMembers.forEach((uid) => {
    if (uid === localUserId) return
    const member = members?.find(m => m.userId === uid)
    if (member) names.push(member.displayName)
  })
  if (names.length === 0) return 'Speaking'
  if (names.length === 1) return names[0]
  if (names.length === 2) return `${names[0]} & ${names[1]}`
  return `${names[0]} +${names.length - 1}`
}

// ─── Fullscreen Speaking Indicator ─────────────────────────────────────────

interface FullscreenSpeakingIndicatorProps {
  isPttActive: boolean
  talkingMembers?: Set<string>
  members?: { userId: string; displayName: string; avatarUrl: string | null; isHost: boolean }[]
  localUserId?: string
}

function FullscreenSpeakingIndicator({ isPttActive, talkingMembers, members, localUserId }: FullscreenSpeakingIndicatorProps) {
  // Build list of speaking users
  const speakingUsers: { userId: string; displayName: string; isLocal: boolean }[] = []

  // Add local user if speaking
  if (isPttActive && localUserId) {
    const localMember = members?.find(m => m.userId === localUserId)
    speakingUsers.push({
      userId: localUserId,
      displayName: localMember?.displayName || 'You',
      isLocal: true,
    })
  }

  // Add remote talking members
  if (talkingMembers) {
    talkingMembers.forEach((uid) => {
      if (uid !== localUserId) {
        const member = members?.find(m => m.userId === uid)
        speakingUsers.push({
          userId: uid,
          displayName: member?.displayName || 'Unknown',
          isLocal: false,
        })
      }
    })
  }

  if (speakingUsers.length === 0) return null

  return (
    <div className="absolute right-3 top-1/2 -translate-y-1/2 z-[130] flex flex-col gap-2">
      <AnimatePresence>
        {speakingUsers.map((user) => (
          <motion.div
            key={user.userId}
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 20 }}
            transition={{ duration: 0.2 }}
            className="flex items-center gap-2 bg-black/70 backdrop-blur-md border border-white/10 rounded-full px-3 py-1.5"
          >
            <Mic className="size-3.5 text-sv-red animate-pulse" />
            <span className="text-[11px] text-white/90 font-medium truncate max-w-[100px]">
              {user.displayName}
            </span>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  )
}

interface WatchPartyPttButtonProps {
  onPttStart: () => void
  onPttStop: () => void
  isPttActive: boolean
  talkingMembers?: Set<string>
  members?: { userId: string; displayName: string; avatarUrl: string | null; isHost: boolean }[]
  localUserId?: string
}

function WatchPartyPttButton({ onPttStart, onPttStop, isPttActive, talkingMembers, members, localUserId }: WatchPartyPttButtonProps) {
  const [isPttPressed, setIsPttPressed] = useState(false)
  const someoneTalking = isPttActive || (talkingMembers && talkingMembers.size > 0)

  const handlePttDown = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsPttPressed(true)
    onPttStart()
  }, [onPttStart])

  const handlePttUp = useCallback(() => {
    setIsPttPressed(false)
    onPttStop()
  }, [onPttStop])

  // Safety: release PTT if mouse/focus leaves the button while held
  useEffect(() => {
    if (!isPttPressed) return
    const release = () => { setIsPttPressed(false); onPttStop() }
    window.addEventListener('mouseup', release)
    window.addEventListener('touchend', release)
    window.addEventListener('touchcancel', release)
    return () => {
      window.removeEventListener('mouseup', release)
      window.removeEventListener('touchend', release)
      window.removeEventListener('touchcancel', release)
    }
  }, [isPttPressed, onPttStop])

  return (
    <div className="absolute right-3 bottom-24 z-[125] flex flex-col items-center gap-2">
      {/* Someone talking indicator */}
      {(isPttActive || (talkingMembers && talkingMembers.size > 0)) && !isPttPressed && (
        <div className="flex items-center gap-1.5 bg-black/70 backdrop-blur-sm border border-white/10 rounded-full px-2.5 py-1">
          <div className="w-2 h-2 rounded-full bg-sv-red animate-pulse" />
          <span className="text-[10px] text-white/80 font-medium">
            {isPttActive ? 'You' : getSpeakingNames(talkingMembers, members, localUserId)}
          </span>
        </div>
      )}

      {/* PTT Button */}
      <button
        onMouseDown={handlePttDown}
        onMouseUp={handlePttUp}
        onMouseLeave={() => { if (isPttPressed) handlePttUp() }}
        onTouchStart={handlePttDown}
        onTouchEnd={handlePttUp}
        onTouchCancel={() => { if (isPttPressed) handlePttUp() }}
        className={cn(
          'flex items-center justify-center w-12 h-12 rounded-full transition-all select-none cursor-pointer',
          isPttPressed
            ? 'bg-sv-red shadow-lg shadow-sv-red/40 scale-110'
            : 'bg-black/60 backdrop-blur-md border border-white/15 hover:bg-white/15'
        )}
        aria-label={isPttPressed ? 'Release to stop talking' : 'Push to talk'}
      >
        {isPttPressed ? (
          <Mic className="h-5 w-5 text-white" />
        ) : (
          <MicOff className="h-5 w-5 text-white/70" />
        )}
      </button>

      {/* Label */}
      <span className={cn(
        'text-[9px] font-medium px-2 py-0.5 rounded-full',
        isPttPressed
          ? 'text-white bg-sv-red/80'
          : 'text-white/50 bg-black/40'
      )}>
        {isPttPressed ? 'Talk' : 'PTT'}
      </span>
    </div>
  )
}

// ─── Main VideoPlayer (Router with HLS → Iframe Auto-Fallback) ──────────────

export default function VideoPlayer(props: VideoPlayerProps) {
  // Defensive: if src is empty AND no fmp4Blob (MSE sets src internally),
  // build a fallback embed URL from contentId/mediaType.
  // When fmp4Blob is provided, empty src is intentional — MSE attaches to
  // the video element directly, so we must NOT generate an embed URL.
  const safeSrc = props.src || props.fmp4Blob
    ? props.src
    : (props.contentId && props.mediaType
      ? `/api/stream/embed?url=${encodeURIComponent(
          props.mediaType === 'tv' && props.season !== undefined && props.episode !== undefined
            ? `https://vidapi.ru/embed/tv/${props.contentId}/${props.season}/${props.episode}#quality=1080p`
            : `https://vidapi.ru/embed/movie/${props.contentId}#quality=1080p`,
        )}`
      : '');

  const [currentSrc, setCurrentSrc] = useState(safeSrc);
  const [forceIframe, setForceIframe] = useState(false);

  // Reset when parent changes src
  if (safeSrc !== currentSrc && !forceIframe) {
    setCurrentSrc(safeSrc);
  }

  // Auto-fallback: when HLS player hits a 403/proxy error,
  // find the first embed URL in fallbackUrls and switch to iframe
  const handleHlsFatalError = useCallback(() => {
    const embedFallbacks = (props.fallbackUrls || []).filter(
      (u) => isEmbedUrl(u) || u.startsWith('/api/stream/embed'),
    );
    if (embedFallbacks.length > 0 && !forceIframe) {
      setCurrentSrc(embedFallbacks[0]);
      setForceIframe(true);
    }
  }, [props.fallbackUrls, forceIframe]);

  const useIframe = isEmbedUrl(currentSrc) || currentSrc.startsWith('/api/stream/embed') || forceIframe;

  const player = useIframe ? (
    <IframeEmbedPlayer
      src={currentSrc}
      fallbackUrls={props.fallbackUrls?.filter((u) => isEmbedUrl(u) && u !== currentSrc)}
      title={props.title}
      mediaType={props.mediaType}
      onClose={props.onClose}
      onProgressUpdate={props.onProgressUpdate}
      onCompleted={props.onCompleted}
      watchPartySync={props.watchPartySync}
      imdbId={props.imdbId}
      contentId={props.contentId}
      season={props.season}
      episode={props.episode}
    />
  ) : (
    <HlsVideoPlayer
      {...props}
      src={currentSrc}
      onFatalError={handleHlsFatalError}
    />
  );

  return (
    <PlayerErrorBoundary onClose={props.onClose} title={props.title} mediaType={props.mediaType}>
      {player}
    </PlayerErrorBoundary>
  );
}
