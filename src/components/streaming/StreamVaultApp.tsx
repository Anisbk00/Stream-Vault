'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { toast } from 'sonner';
import { WifiOff } from 'lucide-react';
import SplashScreen from '@/components/streaming/SplashScreen';
import { useNavigationStore, useWatchlistStore, useUIStore, useDownloadStore, useProgressStore, useAuthStore } from '@/store';
import type { ContentItem } from '@/types/streaming';
import type { DownloadTask } from '@/lib/hls-downloader';
import {
  fetchStreamSources,
  fetchContentDetail,
  fetchTrending,
  fetchPopular,
  fetchGenres,
} from '@/services/api';
import { supabase, getMyProfile, initSupabase, touchProfile } from '@/lib/supabase';
import { startHeartbeat, stopHeartbeat, registerSession, heartbeatSession, getAuthToken } from '@/lib/session-manager';
import { unregisterPlayback as unregisterPlaybackSync } from '@/lib/hls-memory-loader';
import { getCachedProfile } from '@/store';

// Layout
import Navbar from '@/components/streaming/Navbar';
import MobileNav from '@/components/streaming/MobileNav';
import SearchOverlay from '@/components/streaming/SearchOverlay';

// Pages
import HomePage from '@/components/streaming/HomePage';
import BrowsePage from '@/components/streaming/BrowsePage';
import WatchlistPage from '@/components/streaming/WatchlistPage';
import DetailPage from '@/components/streaming/DetailPage';
import VideoPlayer from '@/components/streaming/VideoPlayer';
import DownloadPanel from '@/components/streaming/DownloadPanel';
import ProfilePage from '@/components/streaming/ProfilePage';
import DownloadsPage from '@/components/streaming/DownloadsPage';

// Auth screens
import LoginScreen from '@/components/streaming/LoginScreen';
import ProfileCompletionScreen from '@/components/streaming/ProfileCompletionScreen';

// Watch Party
import WatchPartyInviteOverlay from '@/components/streaming/WatchPartyInviteOverlay';
import WatchPartyRoom from '@/components/streaming/WatchPartyRoom';
import WatchPartyContentPicker from '@/components/streaming/WatchPartyContentPicker';
import { useWatchParty } from '@/hooks/use-watch-party';
import { useWatchPartyStore } from '@/store/watch-party';
import type { WatchPartyInvitation } from '@/lib/watch-party-types';

/* ── iOS-style animation constants ────────────────────────── */
// Apple's signature spring: snappy with natural deceleration
const iosSpring = { type: 'spring' as const, damping: 28, stiffness: 320, mass: 0.9 };
const iosTransition = { duration: 0.35, ease: [0.32, 0.72, 0, 1] as const };
const iosSpringTransition = { ...iosSpring };

// Tab-level page transitions (crossfade with subtle scale)
const pageVariants = {
  initial: (direction: string) => ({
    opacity: 0,
    x: direction === 'forward' ? 20 : direction === 'back' ? -20 : 0,
    scale: 0.98,
  }),
  animate: {
    opacity: 1,
    x: 0,
    scale: 1,
  },
  exit: (direction: string) => ({
    opacity: 0,
    x: direction === 'forward' ? -20 : direction === 'back' ? 20 : 0,
    scale: 0.98,
  }),
};

// Detail page: push from right (forward) / slide back left (backward)
const detailPageVariants = {
  initial: (direction: string) => ({
    opacity: 0,
    x: direction === 'forward' ? 60 : -40,
    scale: 0.96,
    filter: 'blur(4px)',
  }),
  animate: {
    opacity: 1,
    x: 0,
    scale: 1,
    filter: 'blur(0px)',
  },
  exit: (direction: string) => ({
    opacity: 0,
    x: direction === 'forward' ? -40 : 60,
    scale: 0.96,
    filter: 'blur(4px)',
  }),
};

// Module-level throttle state for navigation heartbeat (survives renders, not page reloads)
let _lastNavHeartbeat = 0;
const NAV_HEARTBEAT_THROTTLE_MS = 30_000;

interface StreamVaultAppProps {
  supabaseUrl: string;
  supabaseAnonKey: string;
}

export default function StreamVaultApp({ supabaseUrl, supabaseAnonKey }: StreamVaultAppProps) {
  const currentPage = useNavigationStore((s) => s.currentPage);
  const selectedContentId = useNavigationStore((s) => s.selectedContentId);
  const selectedMediaType = useNavigationStore((s) => s.selectedMediaType);
  const navDirection = useNavigationStore((s) => s.direction);
  const navigate = useNavigationStore((s) => s.navigate);
  const goBack = useNavigationStore((s) => s.goBack);
  const navigatedFromSearch = useNavigationStore((s) => s.navigatedFromSearch);
  const setNavigatedFromSearch = useNavigationStore((s) => s.setNavigatedFromSearch);

  const status = useAuthStore((s) => s.status);
  const setAuth = useAuthStore((s) => s.setAuth);
  const setProfile = useAuthStore((s) => s.setProfile);
  const setStatus = useAuthStore((s) => s.setStatus);
  const setOffline = useAuthStore((s) => s.setOffline);
  const bootstrapFromCache = useAuthStore((s) => s.bootstrapFromCache);
  const isOffline = useAuthStore((s) => s.isOffline);
  const fetchWatchlistFromServer = useWatchlistStore((s) => s.fetchFromServer);
  const syncWatchlistFromServer = useWatchlistStore((s) => s.syncFromServer);
  const watchlistItems = useWatchlistStore((s) => s.items);
  const toggleWatchlist = useWatchlistStore((s) => s.toggleItem);
  const removeWatchlist = useWatchlistStore((s) => s.removeItem);
  const isSearchOpen = useUIStore((s) => s.isSearchOpen);
  const setSearchOpen = useUIStore((s) => s.setSearchOpen);
  const savedSearchQuery = useUIStore((s) => s.savedSearchQuery);
  const savedSearchResults = useUIStore((s) => s.savedSearchResults);
  const saveSearchState = useUIStore((s) => s.saveSearchState);
  const clearSavedSearch = useUIStore((s) => s.clearSavedSearch);
  const isDownloadPanelOpen = useUIStore((s) => s.isDownloadPanelOpen);
  const setDownloadPanelOpen = useUIStore((s) => s.setDownloadPanelOpen);
  const removeDownload = useDownloadStore((s) => s.removeTask);
  const updateProgress = useProgressStore((s) => s.updateProgress);

  // ── Watch Party ───────────────────────────────────────────
  const wpSocket = useWatchParty();
  const isInParty = useWatchPartyStore((s) => s.isInParty);
  const isHost = useWatchPartyStore((s) => s.isHost);
  const currentParty = useWatchPartyStore((s) => s.currentParty);
  const isPttActive = useWatchPartyStore((s) => s.isPttActive);
  const talkingMembers = useWatchPartyStore((s) => s.talkingMembers);
  const pauseNotification = useWatchPartyStore((s) => s.pauseNotification);
  const [wpContentPickerOpen, setWpContentPickerOpen] = useState(false);

  // Track whether the host explicitly closed the player while in a party.
  // Prevents the auto-play effect from immediately reopening the player
  // when the host closes it to change content. Reset when host opens player again.
  const hostClosedPlayerRef = useRef(false);

  // ── Initialize Supabase with Server Component props ─────
  // These props come from the Server Component page.tsx which
  // reads process.env at REQUEST TIME on Vercel (not build time).
  // This is the ONLY reliable way to get correct credentials.
  const [splashDone, setSplashDone] = useState(false);
  const configReady = !!(supabaseUrl && supabaseAnonKey && supabaseAnonKey.length > 10);

  useEffect(() => {
    if (supabaseUrl && supabaseAnonKey) {
      initSupabase(supabaseUrl, supabaseAnonKey);
    }
  }, [supabaseUrl, supabaseAnonKey]);

  // ── Pre-fetch data during splash (non-blocking) ────────
  useEffect(() => {
    if (splashDone) return;
    const controller = new AbortController();
    const signal = controller.signal;

    // Fire-and-forget: prefetch trending, popular, genres for instant page loads
    Promise.allSettled([
      fetchTrending(1, 'all', signal).catch(() => []),
      fetchPopular(1, 'movie', signal).catch(() => []),
      fetchPopular(1, 'tv', signal).catch(() => []),
      fetchGenres('movie', signal).catch(() => []),
      fetchGenres('tv', signal).catch(() => []),
    ]);

    return () => controller.abort();
  }, [splashDone]);

  // ── Bootstrap from localStorage cache (post-hydration) ────
  useEffect(() => {
    bootstrapFromCache();
  }, [bootstrapFromCache]);

  // ── Cleanup stale download tasks after persist rehydration ────
  // If the app was closed/killed during a download, the task stays as
  // 'downloading'/'pending' in persisted store but the JS execution is dead.
  // Reset them to 'error' so the user can retry.
  // CRITICAL: Must run AFTER persist rehydration — otherwise the store is
  // empty (before rehydration) and stale tasks from localStorage go unnoticed.
  useEffect(() => {
    const doCleanup = () => {
      import('@/lib/download-service').then(({ cleanupStaleTasks }) => {
        cleanupStaleTasks();
      });
    };
    // Zustand persist exposes onFinishHydration — fires once after rehydration
    const unsub = useDownloadStore.persist.onFinishHydration(doCleanup);
    // If rehydration already completed (edge case), run immediately
    if (useDownloadStore.persist.hasHydrated()) {
      doCleanup();
    }
    return unsub;
  }, []);

  // ── Block popup windows from embed players ────────────────────
  useEffect(() => {
    const originalOpen = window.open;
    window.open = function (...args) {
      // Block popup windows (ads). Only allow if it's from our own domain.
      const url = args[0]?.toString() || '';
      if (url && (url.startsWith('/') || url.includes(window.location.hostname))) {
        return originalOpen.apply(window, args);
      }
      return null;
    };
    return () => {
      window.open = originalOpen;
    };
  }, []);

  // ── Dismiss splash once auth resolves ──────────────────────
  useEffect(() => {
    if (status !== 'loading' && configReady) {
      // Let the splash animation fully play before cross-fading to app
      const timer = setTimeout(() => setSplashDone(true), 2200);
      return () => clearTimeout(timer);
    }
  }, [status, configReady]);

  // ── Safety net: force exit loading state after 6 seconds ───
  useEffect(() => {
    const timer = setTimeout(() => {
      if (useAuthStore.getState().status === 'loading') {
        // DO NOT force-authenticate from cached token without validation.
        // The auth effect (validateSession) handles token validation.
        // If it's still loading after 6s, something is genuinely stuck —
        // fall through to unauthenticated rather than granting unvalidated access.
        setStatus('unauthenticated');
      }
    }, 6000);
    return () => clearTimeout(timer);
  }, [setStatus]);

  // ── Auth: validate session with Supabase ──────────────────
  // Only runs after config is ready (dependency on configReady).
  useEffect(() => {
    if (!configReady) return;

    let mounted = true;
    let subscription: { unsubscribe: () => void } | null = null;

    async function init() {
      // Set up auth subscription
      subscription = supabase.auth.onAuthStateChange(
        async (_event, session) => {
          if (!mounted) return;

          // ── Null session: NEVER clear state from this handler ──
          // signOut() fires SIGNED_OUT asynchronously (queued by GoTrue).
          // A delayed SIGNED_OUT from a previous signOut can arrive AFTER
          // a new signInWithPassword() + setStatus('authenticated'), wiping
          // the fresh session. The previous status guard couldn't prevent
          // this because status IS 'authenticated' at that point.
          //
          // Instead, this handler ONLY syncs state when a valid session
          // exists. Null-session events are handled by:
          // - logout() — clears state directly before calling signOut.
          // - 10s heartbeat — detects session eviction server-side.
          // - GoTrue's auto-refresh — handles token renewal internally.
          if (!session) return;

          // ── Not authenticated: LoginScreen handles sign-in directly ──
          // Don't process SIGNED_IN/TOKEN_REFRESHED during login — the
          // login handler sets auth state directly via setAuth + setStatus.
          if (useAuthStore.getState().status !== 'authenticated') return;

          // ── Offline: don't trigger profile fetch when offline ──
          if (!navigator.onLine) return;

          try {
            // Session refreshed or user updated — re-sync auth + profile
            setAuth(session.user, session);
            const profile = await getMyProfile();
            if (profile) setProfile(profile);
          } catch {
            // Non-critical: transient error (network blip, Supabase hiccup).
            // The next heartbeat or online event will retry profile sync.
          }
        },
      ).data.subscription;

      // Validate session
      try {
        const { data: { session } } = await supabase.auth.getSession();

        if (!session) {
          // OFFLINE RECOVERY: getSession() may return null when Supabase cleared
          // the stored session during a failed token refresh. If we're offline
          // and have a cached session in localStorage, recover from it instead
          // of wiping the auth state.
          if (!navigator.onLine) {
            try {
              const raw = localStorage.getItem('streamvault-auth-token');
              if (raw) {
                const cached = JSON.parse(raw);
                if (cached?.access_token) {
                  // Keep the authenticated state from bootstrapFromCache
                  return;
                }
              }
            } catch { /* ignore parse errors */ }
          }
          if (mounted) {
            setProfile(null);
            setStatus('unauthenticated');
          }
          return;
        }

        if (mounted) setAuth(session.user, session);

        const metaCompleted = !!session.user.user_metadata?.profile_completed;
        const profile = await getMyProfile();
        if (!mounted) return;

        setProfile(profile);

        if (metaCompleted || (profile && profile.display_name.trim().length > 0)) {
          setStatus('authenticated');
          if (session.access_token) {
            fetchWatchlistFromServer(session.access_token);
            // Bump updated_at to signal user activity (throttled to 1h)
            touchProfile(profile?.updated_at);
          }
        } else {
          setStatus('needs_profile');
        }
      } catch {
        if (mounted) {
          const current = useAuthStore.getState().status;
          // OFFLINE RECOVERY: bootstrapFromCache() already set status to
          // 'authenticated'. Don't overwrite it with 'unauthenticated' just
          // because getMyProfile() failed (expected when offline).
          if (current === 'loading') {
            const cached = getCachedProfile();
            if (cached && cached.display_name.trim().length > 0) {
              setProfile(cached);
              setStatus('authenticated');
              // Only mark offline if actually offline — getMyProfile() can
              // fail for non-offline reasons (RLS, Supabase hiccup, etc.)
              if (!navigator.onLine) setOffline(true);
            } else {
              setStatus('unauthenticated');
            }
          } else if (current === 'authenticated') {
            // Already recovered by bootstrap — only mark offline if actually offline
            if (!navigator.onLine) setOffline(true);
          }
        }
      }
    }

    init();

    return () => {
      mounted = false;
      if (subscription) subscription.unsubscribe();
    };
  }, [configReady, setAuth, setProfile, setStatus, setOffline, fetchWatchlistFromServer]);

  // ── Online/offline listeners ─────────────────────────────
  useEffect(() => {
    const goOffline = () => setOffline(true);
    const goOnline = () => {
      setOffline(false);
      supabase.auth.getSession().then(async ({ data: { session } }) => {
        if (!session) return;
        try {
          const profile = await getMyProfile();
          if (profile) setProfile(profile);
        } catch { /* will retry on next online event */ }
      });
    };

    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, [setOffline, setProfile]);

  // ── Session heartbeat & eviction detection ─────────────────
  // Starts when authenticated, stops on logout/unmount.
  // If the heartbeat detects the session was evicted (user logged in
  // on a 3rd device → oldest session killed), force sign-out.
  useEffect(() => {
    if (status !== 'authenticated') {
      stopHeartbeat();
      return;
    }

    // Register session on first authenticated mount (existing session from
    // another device that was already running — ensures heartbeat works).
    // Only sign out on hard rejection (rejected: true + active: false).
    // Null (network error) or tracked: false → allow (fail-open).
    registerSession().then((result) => {
      if (result?.rejected && !result.active) {
        toast.error(result.reason || 'Too many active devices. Sign out from another device first.', {
          duration: 6000,
        });
        useAuthStore.getState().logout();
      }
    });

    const handleEvicted = () => {
      // Session was evicted by a newer login on another device
      toast.error('You have been signed out because your account is being used on another device.', {
        duration: 6000,
      });
      useAuthStore.getState().logout();
    };

    const cleanup = startHeartbeat(handleEvicted);

    return cleanup;
  }, [status]);

  // ── Re-open search overlay when going back from detail (search restore) ──
  useEffect(() => {
    if (navigatedFromSearch && currentPage !== 'detail' && !isSearchOpen && savedSearchQuery) {
      setNavigatedFromSearch(false);
      setSearchOpen(true);
    }
  }, [navigatedFromSearch, currentPage, isSearchOpen, savedSearchQuery, setNavigatedFromSearch, setSearchOpen]);

  // ── Destroy session on logout ──────────────────────────────
  // Note: destroySession() is called inside logout() in the auth store,
  // BEFORE supabase.auth.signOut() destroys the token. This effect is
  // intentionally empty — kept as a marker so future developers know
  // where session cleanup happens.
  useEffect(() => {
    if (status === 'unauthenticated') {
      // Session already destroyed by store.logout() before token was cleared
    }
  }, [status]);

  // Video player state
  const [playerState, setPlayerState] = useState<{
    isOpen: boolean;
    src: string;
    fallbackUrls: string[];
    title: string;
    poster?: string;
    contentId?: string | number;
    mediaType?: 'movie' | 'tv';
    season?: number;
    episode?: number;
    startTime?: number;
    /** Downloaded subtitle VTT blob URLs, keyed by language */
    subtitleUrls?: Record<string, string>;
    /** Subtitle track metadata for UI display */
    subtitleTracks?: { language: string; name: string; isDefault: boolean }[];
    /** Force HLS.js playback (for downloaded HLS content played via fake m3u8) */
    useHls?: boolean;
    /** ID for in-memory segment data (custom HLS.js loader) */
    hlsPlaybackId?: string;
    /** fMP4 blob for MSE-based playback (downloaded HLS remuxed to MP4) */
    fmp4Blob?: Blob;
  }>({
    isOpen: false,
    src: '',
    fallbackUrls: [],
    title: '',
  });

  const [playedItem, setPlayedItem] = useState<ContentItem | null>(null);
  const mainRef = useRef<HTMLElement>(null);

  // AbortController to cancel stale stream source fetches (prevents wrong content
  // from opening when user rapidly taps play on different items)
  const sourceFetchControllerRef = useRef<AbortController | null>(null);

  // Track blob URLs created for downloaded content playback — must be revoked on
  // player close to prevent memory leaks (video blobs can be 100MB+)
  const playbackBlobUrlsRef = useRef<string[]>([]);

  // Track current hlsPlaybackId in a ref so handleClosePlayer can read it
  // without depending on playerState.hlsPlaybackId (avoids callback recreation
  // and race conditions with async import() during close)
  const hlsPlaybackIdRef = useRef<string | null>(null);

  // Scroll main content to top on page change
  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
  }, [currentPage]);

  // Sync watchlist from server when navigating to mylist page
  useEffect(() => {
    if (currentPage === 'mylist' && status === 'authenticated') {
      syncWatchlistFromServer();
    }
  }, [currentPage, status, syncWatchlistFromServer]);

  const handleNavigate = useCallback(
    (page: string, id?: string | number) => {
      // Throttled session validity check on navigation (max once per 30 seconds).
      // The periodic 10-second heartbeat handles real-time session monitoring.
      // This navigation check catches edge cases (user away > 10s, then navigates).
      const now = Date.now();
      if (now - _lastNavHeartbeat > NAV_HEARTBEAT_THROTTLE_MS) {
        _lastNavHeartbeat = now;
        heartbeatSession().then(async (result) => {
          if (result && !result.active) {
            // Session not found on server (stale purge or eviction).
            // Try to re-register before force-logging out.
            const token = await getAuthToken();
            if (token) {
              const reReg = await registerSession(false, token);
              if (reReg?.active) return; // Successfully re-registered — no action needed
              if (reReg?.rejected) {
                // Max devices reached — log out
                toast.error('You have been signed out because your account is being used on another device.', {
                  duration: 6000,
                });
                useAuthStore.getState().logout();
                return;
              }
            }
            // Re-registration failed (network error, etc.) — only evict if explicitly evicted
            if (result.evicted) {
              toast.error('You have been signed out because your account is being used on another device.', {
                duration: 6000,
              });
              useAuthStore.getState().logout();
            }
            // Otherwise (stale purge / transient error) — don't log out, let next heartbeat fix it
          }
        });
      }
      navigate(page as never, id ?? null);
      window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
    },
    [navigate]
  );

  const handleItemClick = useCallback(
    (item: ContentItem) => {
      const mediaType = (item.media_type === 'tv' ? 'tv' : 'movie') as 'movie' | 'tv';
      setPlayedItem(item);
      navigate('detail', item.id, mediaType);
      window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
    },
    [navigate]
  );

  const buildEmbedUrl = useCallback(
    (mediaType: 'movie' | 'tv', contentId: string | number, season?: number, episode?: number): string => {
      // Use direct embed URL — proxy wrapping breaks the player's origin
      // (was the root cause of CORS errors on web and "something went wrong" in PWA)
      if (mediaType === 'tv' && season !== undefined && episode !== undefined) {
        return `https://vidapi.ru/embed/tv/${contentId}/${season}/${episode}#quality=1080p`;
      }
      return `https://vidapi.ru/embed/movie/${contentId}#quality=1080p`;
    },
    [],
  );

  /** Pick best playback source:
   *  Strategy: Embed iframes are PRIMARY — they load the video on the embed
   *  provider's own domain, bypassing CORS and CDN IP restrictions that
   *  commonly block server-side proxies (Vercel datacenter IPs are often
   *  blocked by CDNs like justhd.tv, returning 403 regardless of headers).
   *
   *  HLS/MP4 sources are included in the fallback list and can be tried
   *  by HlsVideoPlayer's retry logic if the user manually cycles sources.
   */
  const pickBestSource = useCallback(
    (sourceData: Awaited<ReturnType<typeof fetchStreamSources>>, embedFallback: string) => {
      // Prefer embed URLs — they load directly in the browser (no proxy needed)
      if (embedFallback) return embedFallback;
      // No embed available — fall back to HLS/MP4 direct sources
      if (sourceData.sources && sourceData.sources.length > 0) {
        const hlsSource = sourceData.sources.find((s) => s.type === 'hls');
        if (hlsSource?.url) return hlsSource.url;
        const mp4Source = sourceData.sources.find((s) => s.type === 'mp4');
        if (mp4Source?.url) return mp4Source.url;
      }
      return embedFallback;
    },
    [],
  );

  /** Build fallback URL list:
   *  1. Embed URLs — primary fallback for IframeEmbedPlayer source cycling.
   *  2. Other HLS/MP4 sources — included so HlsVideoPlayer can try them
   *     if user manually cycles or if no embeds are available.
   */
  const buildFallbackList = useCallback(
    (sourceData: Awaited<ReturnType<typeof fetchStreamSources>>, playSrc: string) => {
      const urls: string[] = [];

      // Add embed URLs first — they load directly (no proxy needed)
      for (const fb of sourceData.fallbackUrls) {
        if (fb !== playSrc && !urls.includes(fb)) {
          urls.push(fb);
        }
      }

      // Include the primary embed URL if not already the play source
      if (sourceData.embedUrl && sourceData.embedUrl !== playSrc && !urls.includes(sourceData.embedUrl)) {
        urls.push(sourceData.embedUrl);
      }

      // Add other direct HLS/MP4 sources last (require proxy — may 403 from datacenter IPs)
      if (sourceData.sources) {
        for (const s of sourceData.sources) {
          if (s.url && s.url !== playSrc && !urls.includes(s.url)) urls.push(s.url);
        }
      }

      return urls;
    },
    [],
  );

  const handlePlay = useCallback(async (item: ContentItem) => {
    const mediaType = (item.media_type === 'tv' ? 'tv' : 'movie') as 'movie' | 'tv';
    setPlayedItem(item);

    // Cancel any in-flight source fetch to prevent stale responses
    sourceFetchControllerRef.current?.abort();
    const controller = new AbortController();
    sourceFetchControllerRef.current = controller;

    try {
      const sourceData = await fetchStreamSources(item.id, mediaType, undefined, undefined, controller.signal);
      // Guard: if a newer play request was started while this was in-flight, discard stale response
      if (controller.signal.aborted) return;
      const playSrc = pickBestSource(sourceData, sourceData.embedUrl);
      const fallbackUrls = buildFallbackList(sourceData, playSrc);
      // Ensure src is never empty — fall back to proxy-wrapped embed URL
      const safeSrc = playSrc || buildEmbedUrl(mediaType, item.id);
      setPlayerState({
        isOpen: true,
        src: safeSrc,
        fallbackUrls: safeSrc === playSrc ? fallbackUrls : [],
        title: item.title || item.name || 'Untitled',
        poster: item.backdrop_path
          ? `https://image.tmdb.org/t/p/w780${item.backdrop_path}`
          : undefined,
        contentId: item.id,
        mediaType,
      });
    } catch (err) {
      // If aborted due to newer play request, silently discard
      if (controller.signal.aborted) return;
      // fetchStreamSources failed — use buildEmbedUrl as primary,
      // plus fallback embed URLs from other providers
      const primaryEmbed = buildEmbedUrl(mediaType, item.id);
      const extraFallbacks: string[] = [
        // Embed.su fallback
        mediaType === 'tv'
          ? `https://embed.su/embed/tv/${item.id}/1/1`
          : `https://embed.su/embed/movie/${item.id}`,
        // 2Embed fallback
        mediaType === 'movie'
          ? `https://www.2embed.cc/embed/${item.id}`
          : `https://www.2embed.cc/embedtv/${item.id}&s=1&e=1`,
        // VidSrc.to fallback
        mediaType === 'tv'
          ? `https://vidsrc.to/embed/tv/${item.id}/1/1`
          : `https://vidsrc.to/embed/movie/${item.id}`,
      ].filter((u) => u !== primaryEmbed);
      setPlayerState({
        isOpen: true,
        src: primaryEmbed,
        fallbackUrls: extraFallbacks,
        title: item.title || item.name || 'Untitled',
        poster: item.backdrop_path
          ? `https://image.tmdb.org/t/p/w780${item.backdrop_path}`
          : undefined,
        contentId: item.id,
        mediaType,
      });
    }
  }, [buildEmbedUrl, pickBestSource, buildFallbackList]);

  const handlePlayWithParams = useCallback(
    async (
      contentId: string | number,
      mediaType: 'movie' | 'tv',
      season?: number,
      episode?: number
    ) => {
      const title = playedItem?.title || playedItem?.name || 'Untitled';
      const seasonEp = `${season !== undefined ? ` S${season}` : ''}${episode !== undefined ? ` E${episode}` : ''}`;

      // Cancel any in-flight source fetch to prevent stale responses
      sourceFetchControllerRef.current?.abort();
      const controller = new AbortController();
      sourceFetchControllerRef.current = controller;

      try {
        const sourceData = await fetchStreamSources(contentId, mediaType, season, episode, controller.signal);
        if (controller.signal.aborted) return;
        const playSrc = pickBestSource(sourceData, sourceData.embedUrl);
        const fallbackUrls = buildFallbackList(sourceData, playSrc);
        // Ensure src is never empty — fall back to proxy-wrapped embed URL
        const safeSrc = playSrc || buildEmbedUrl(mediaType, contentId, season, episode);
        setPlayerState({
          isOpen: true,
          src: safeSrc,
          fallbackUrls: safeSrc === playSrc ? fallbackUrls : [],
          title: `${title}${seasonEp}`,
          poster: playedItem?.backdrop_path
            ? `https://image.tmdb.org/t/p/w780${playedItem.backdrop_path}`
            : undefined,
          contentId,
          mediaType,
          season,
          episode,
        });
      } catch (err) {
        if (controller.signal.aborted) return;
        // fetchStreamSources failed — use buildEmbedUrl as primary,
        // plus fallback embed URLs from other providers
        const primaryEmbed = buildEmbedUrl(mediaType, contentId, season, episode);
        const extraFallbacks: string[] = [
          // Embed.su fallback
          mediaType === 'tv'
            ? `https://embed.su/embed/tv/${contentId}/${season ?? 1}/${episode ?? 1}`
            : `https://embed.su/embed/movie/${contentId}`,
          // 2Embed fallback
          mediaType === 'movie'
            ? `https://www.2embed.cc/embed/${contentId}`
            : `https://www.2embed.cc/embedtv/${contentId}&s=${season ?? 1}&e=${episode ?? 1}`,
          // VidSrc.to fallback
          mediaType === 'tv'
            ? `https://vidsrc.to/embed/tv/${contentId}/${season ?? 1}/${episode ?? 1}`
            : `https://vidsrc.to/embed/movie/${contentId}`,
        ].filter((u) => u !== primaryEmbed);
        setPlayerState({
          isOpen: true,
          src: primaryEmbed,
          fallbackUrls: extraFallbacks,
          title: `${title}${seasonEp}`,
          poster: playedItem?.backdrop_path
            ? `https://image.tmdb.org/t/p/w780${playedItem.backdrop_path}`
            : undefined,
          contentId,
          mediaType,
          season,
          episode,
        });
      }
    },
    [playedItem, buildEmbedUrl, pickBestSource, buildFallbackList]
  );

  const handleAddList = useCallback(
    (item: ContentItem) => {
      toggleWatchlist(item);
    },
    [toggleWatchlist]
  );

  const handleClosePlayer = useCallback(() => {
    // Revoke any blob URLs created for downloaded content playback
    // to prevent memory leaks (video blobs can be 100MB+)
    for (const url of playbackBlobUrlsRef.current) {
      URL.revokeObjectURL(url);
    }
    playbackBlobUrlsRef.current = [];

    // Free in-memory segment data held by MemoryHlsLoader.
    // Uses a ref to read hlsPlaybackId so this callback has a stable identity
    // (no dependency on playerState.hlsPlaybackId). The previous version
    // depended on playerState.hlsPlaybackId which caused the callback to be
    // recreated on every playerState change, and the async import() could race
    // with a new playback session — unregistering data that was just registered.
    const pid = hlsPlaybackIdRef.current;
    if (pid) {
      unregisterPlaybackSync(pid);
      hlsPlaybackIdRef.current = null;
    }

    // If the host closes the player while in a party, mark it so the
    // auto-play effect doesn't immediately reopen it. Also navigate
    // to the detail page of the current party content so the host can
    // pick a different episode or movie.
    if (useWatchPartyStore.getState().isHost && useWatchPartyStore.getState().isInParty) {
      hostClosedPlayerRef.current = true;
      const party = useWatchPartyStore.getState().currentParty;
      if (party?.contentId) {
        useNavigationStore.getState().navigate(
          'detail',
          party.contentId,
          party.mediaType ?? 'movie',
        );
      }
    }

    setPlayerState((prev) => ({ ...prev, isOpen: false, hlsPlaybackId: undefined, useHls: undefined, fmp4Blob: undefined }));
  }, []);

  // Guard against triple invocation from React re-renders
  const playDownloadGuardRef = useRef<string | null>(null);

  const handlePlayDownload = useCallback(
    async (task: DownloadTask) => {
      // Dedup: if the same task is already being prepared, ignore rapid re-calls
      if (playDownloadGuardRef.current === task.id) return;
      playDownloadGuardRef.current = task.id;
      // Clear guard after a safe window (covers async operations)
      setTimeout(() => { playDownloadGuardRef.current = null; }, 5000);

      console.log(
        `[SV Playback] handlePlayDownload called: title='${task.title}', ` +
        `isHlsDownload=${task.isHlsDownload}, hasLocalCopy=${task.hasLocalCopy}, ` +
        `segmentMeta=${task.segmentMeta ? task.segmentMeta.length + ' entries' : 'none'}`,
      );

      // Resolve blob: module-level cache first, then IndexedDB
      let blob: Blob | null = null;
      if (task.hasLocalCopy) {
        // Try module-level cache first (fast — no IndexedDB overhead)
        const { getCachedBlob } = await import('@/lib/download-service');
        blob = getCachedBlob(task.id);
        if (blob) {
          console.log(
            `[SV Playback] Blob loaded from MEMORY cache: ${blob.size} bytes, type='${blob.type}'`,
          );
        } else {
          // Fall back to IndexedDB (page was reloaded, cache is empty)
          toast.loading('Loading video…', { id: 'load-blob' });
          try {
            const { loadBlob } = await import('@/lib/download-storage');
            blob = await loadBlob(task.id);
            // Blob loaded from IndexedDB
            if (!blob) {
              // Blob not found in IndexedDB
              console.error(`[SV Playback] Blob NOT FOUND in IndexedDB for task ${task.id}`);
              toast.error('Video not found — re-download required', { id: 'load-blob' });
              return;
            }
            console.log(
              `[SV Playback] Blob loaded from IndexedDB: ${blob.size} bytes, type='${blob.type}'`,
            );
            toast.success('Ready to play', { id: 'load-blob', duration: 1500 });
          } catch (e) {
            console.error('[SV Playback] Failed to load blob from IndexedDB:', e);
            toast.error('Could not load video', { id: 'load-blob' });
            return;
          }
        }
      }

      if (!blob) {
        // No blob available
        console.error(
          `[SV Playback] No blob available for task '${task.title}' — ` +
          `hasLocalCopy=${task.hasLocalCopy}. Cannot play.`,
        );
        return;
      }

      // Track blob URLs created in this handler for cleanup on player close
      const blobUrlsToTrack: string[] = [];
      let videoSrc: string;

      let useMemoryLoaderPath = false;
      if (task.isHlsDownload && blob.type === 'video/mp2t' && task.segmentMeta && task.segmentMeta.length > 0) {
        // ── Raw TS download (remux failed) → play via HLS.js + MemoryHlsLoader ──
        // This is the fallback path when TS→MP4 remuxing fails.
        // New downloads are remuxed to MP4 and skip this path entirely.
        console.warn(
          `[SV Playback] ⚠️ Using FALLBACK MemoryHlsLoader path — blob type is '${blob.type}', ` +
          `meaning TS→MP4 remux FAILED during download. This path is prone to freezing/desync.`,
        );
        const playbackId = task.id;
        const segmentCount = task.segmentMeta.length;
        toast.loading('Preparing video for playback…', { id: 'mem-loader' });

        try {
          const maxDuration = task.segmentMeta.reduce(
            (max, seg) => Math.max(max, seg.duration), 0,
          );

          const m3u8Lines = [
            '#EXTM3U',
            '#EXT-X-VERSION:3',
            `#EXT-X-TARGETDURATION:${Math.ceil(maxDuration)}`,
            '#EXT-X-PLAYLIST-TYPE:VOD',
            '#EXT-X-MEDIA-SEQUENCE:0',
          ];
          for (let i = 0; i < segmentCount; i++) {
            const seg = task.segmentMeta[i];
            if (seg.discontinuity) {
              m3u8Lines.push('#EXT-X-DISCONTINUITY');
            }
            m3u8Lines.push(`#EXTINF:${seg.duration.toFixed(6)},`);
            m3u8Lines.push(`mem://${playbackId}/seg/${i}`);
          }
          m3u8Lines.push('#EXT-X-ENDLIST');
          const m3u8 = m3u8Lines.join('\n');

          console.log(
            `[SV Playback] Generated fake m3u8: ${segmentCount} segments, ` +
            `TARGETDURATION=${Math.ceil(maxDuration)}, total m3u8 length=${m3u8.length} chars`,
          );

          const { registerPlayback } = await import('@/lib/hls-memory-loader');
          registerPlayback(playbackId, m3u8, blob, task.segmentMeta);

          hlsPlaybackIdRef.current = playbackId;

          videoSrc = `mem://${playbackId}/playlist.m3u8`;
          useMemoryLoaderPath = true;
          toast.success('Ready to play', { id: 'mem-loader', duration: 1500 });
        } catch (err) {
          console.error(`[SV Playback] MemoryHlsLoader setup FAILED:`, err);
          toast.error('Could not prepare video for playback', { id: 'mem-loader' });
          return;
        }
      } else if (task.isHlsDownload && blob.type === 'video/mp4') {
        // ── Remuxed fMP4 download → play via blob URL ──
        // For downloaded content, blob URL is the simplest and most reliable
        // playback method. The entire file is already in memory, so the browser
        // can parse and play it natively without the complexity of MSE.
        //
        // The previous MSE progressive approach had a deadlock: when the video
        // stalled, `timeupdate` stopped firing, so no more segments were appended,
        // so the video stayed stalled permanently. Blob URL avoids this entirely.
        console.log(
          `[SV Playback] ✓ Using blob URL playback path — blob type='${blob.type}', ` +
          `size=${(blob.size / 1024 / 1024).toFixed(2)} MB.`,
        );
        videoSrc = URL.createObjectURL(blob);
        blobUrlsToTrack.push(videoSrc);
      } else {
        // ── Direct MP4 download → play via blob URL ──
        console.log(
          `[SV Playback] ✓ Using blob URL playback path — blob type='${blob.type}', ` +
          `size=${(blob.size / 1024 / 1024).toFixed(2)} MB.`,
        );
        videoSrc = URL.createObjectURL(blob);
        blobUrlsToTrack.push(videoSrc);
      }

      // Load subtitles from IndexedDB if available
      const subtitleUrls: Record<string, string> = {};
      if (task.hasSubtitles && task.subtitleTracks) {
        try {
          const { loadSubtitle } = await import('@/lib/download-storage');
          for (const track of task.subtitleTracks) {
            const vttContent = await loadSubtitle(task.id, track.language);
            if (vttContent) {
              const vttBlob = new Blob([vttContent], { type: 'text/vtt' });
              const url = URL.createObjectURL(vttBlob);
              subtitleUrls[track.language] = url;
              blobUrlsToTrack.push(url);
            }
          }
        } catch {
          // Subtitle loading failed — play without subtitles
        }
      }

      playbackBlobUrlsRef.current = blobUrlsToTrack;
      const title = `${task.title}${task.season !== undefined && task.episode !== undefined ? ` S${task.season} E${task.episode}` : ''}`;
      // Load cached poster from IndexedDB (avoids CORS — image.tmdb.org blocks direct fetch)
      let posterSrc: string | undefined;
      if (task.posterUrl) {
        try {
          const { loadPoster } = await import('@/lib/download-storage');
          const posterBlob = await loadPoster(task.contentId);
          if (posterBlob) {
            posterSrc = URL.createObjectURL(posterBlob);
            blobUrlsToTrack.push(posterSrc);
          } else {
            // Fallback: proxy through API to avoid CORS
            posterSrc = `/api/stream/proxy?url=${encodeURIComponent(task.posterUrl)}`;
          }
        } catch {
          posterSrc = `/api/stream/proxy?url=${encodeURIComponent(task.posterUrl)}`;
        }
      }

      setPlayerState({
        isOpen: true,
        src: videoSrc,
        fallbackUrls: [],
        title,
        poster: posterSrc,
        contentId: task.contentId,
        mediaType: task.mediaType,
        season: task.season,
        episode: task.episode,
        subtitleUrls: Object.keys(subtitleUrls).length > 0 ? subtitleUrls : undefined,
        subtitleTracks: task.subtitleTracks,
        // HLS.js + MemoryHlsLoader for TS downloads; MSE for fMP4; blob URL for direct downloads
        useHls: useMemoryLoaderPath,
        // Always pass task ID so MSE path can find cached segments from remux.
        // Without this, getCachedSegments() returns null and the player falls
        // back to parseFmp4Fragments()+combineFragmentPairs() which incorrectly
        // pairs video+audio fragments from different time ranges → decoder stall.
        hlsPlaybackId: useMemoryLoaderPath ? task.id : undefined,
        fmp4Blob: undefined,
        autoPlay: true,
      });
      setDownloadPanelOpen(false);
    },
    [setDownloadPanelOpen],
  );

  const handleProgressUpdate = useCallback(
    (time: number, duration: number) => {
      if (!playerState.contentId || duration <= 0) return;
      updateProgress({
        contentId: playerState.contentId,
        mediaType: playerState.mediaType,
        season: playerState.season,
        episode: playerState.episode,
        progress: time,
        duration,
        updatedAt: Date.now(),
      });
    },
    [playerState.contentId, playerState.mediaType, playerState.season, playerState.episode, updateProgress]
  );

  // ── Watch Party Handlers ────────────────────────────────
  const handleWpPickContent = useCallback(async (item: ContentItem & { season?: number; episode?: number }) => {
    if (!currentParty) return;
    const mediaType = (item.media_type === 'tv' ? 'tv' : 'movie') as 'movie' | 'tv';
    await wpSocket.pickContent({
      contentId: String(item.id),
      mediaType,
      season: item.season,
      episode: item.episode,
      contentTitle: item.title || item.name || 'Untitled',
      contentPoster: item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : undefined,
    });
  }, [currentParty, wpSocket.pickContent]);

  const handleWpStartParty = useCallback(async () => {
    hostClosedPlayerRef.current = false;
    useWatchPartyStore.getState().setRoomVisible(false);
    await wpSocket.startParty(0);
    // The auto-play effect (below) handles opening the player for the host.
    // We do NOT call handlePlay here because it would race with the
    // auto-play effect, causing the fetch to be aborted and the player
    // to never open. The auto-play effect triggers on currentParty.status
    // changing to 'playing' (set by startParty above).
  }, [wpSocket.startParty]);

  const handleWpAcceptInvite = useCallback(async (invitation: WatchPartyInvitation) => {
    const result = await wpSocket.acceptInvite(invitation.partyId);
    // acceptInvite shows its own detailed step-by-step error toasts.
    // On success: toast.success('Joined watch party!')
    // On failure: specific error messages with DB error details
    // Fallback if the store wasn't updated but no toast was shown:
    if (!result) {
      const store = useWatchPartyStore.getState();
      if (!store.isInParty) {
        toast.error('Could not join the watch party. It may have ended or you lack permission.', { id: 'wp-join-flow' });
      }
    }
  }, [wpSocket.acceptInvite]);

  const handleWpRejectInvite = useCallback(async (invitation: WatchPartyInvitation) => {
    await wpSocket.rejectInvite(invitation.partyId, invitation.hostId);
  }, [wpSocket.rejectInvite]);

  const handleWpPlayContent = useCallback(async (item: ContentItem) => {
    // Play the content the host picked for the watch party
    await handlePlay(item);
  }, [handlePlay]);

  // ── Watch Party: Auto-play content when party starts ───
  useEffect(() => {
    if (!currentParty || !currentParty.contentId || currentParty.status !== 'playing') return;
    if (playerState.isOpen && String(playerState.contentId) === String(currentParty.contentId)) return;

    // If the host explicitly closed the player to change content, don't
    // auto-reopen it. The host will open the player manually when ready.
    // (Members should always auto-play.)
    if (isHost && hostClosedPlayerRef.current) return;

    // Auto-play the content for the watch party.
    // Minimize the room panel so it doesn't overlap the player.
    useWatchPartyStore.getState().setRoomVisible(false);

    const item: ContentItem = {
      id: currentParty.contentId,
      title: currentParty.contentTitle ?? undefined,
      name: currentParty.contentTitle ?? undefined,
      media_type: currentParty.mediaType ?? 'movie',
      backdrop_path: currentParty.contentPoster ? currentParty.contentPoster.replace('https://image.tmdb.org/t/p/w500', '') : undefined,
      poster_path: currentParty.contentPoster ? currentParty.contentPoster.replace('https://image.tmdb.org/t/p/w500', '') : undefined,
    };

    // For TV shows with season/episode info, use handlePlayWithParams
    if (currentParty.mediaType === 'tv' && currentParty.season != null && currentParty.episode != null) {
      handlePlayWithParams(item.id, 'tv', currentParty.season, currentParty.episode);
    } else {
      handlePlay(item);
    }
  }, [currentParty?.status, currentParty?.contentId, currentParty?.mediaType, currentParty?.season, currentParty?.episode, currentParty?.playbackState?.isPlaying, handlePlay, playerState.isOpen, playerState.contentId]);

  // ── Watch Party: Host auto-pick + start when opening player directly ───
  // When the host opens the video player while in a party, automatically
  // pick the content and start the party so members see it too.
  useEffect(() => {
    if (!isHost || !isInParty || !currentParty) return;
    if (!playerState.isOpen || !playerState.contentId) return;

    // Host manually opened the player — clear the "closed by host" flag
    // so future content changes will auto-play again.
    hostClosedPlayerRef.current = false;

    const partyContentId = currentParty.contentId
    const playerContentId = String(playerState.contentId)

    // Auto-pick content if not yet picked or if the host switched content
    // IMPORTANT: await pickContent before startParty to prevent race condition
    // where startParty broadcasts before content is set in DB, causing members
    // to see status='playing' but contentId=null.
    if (!partyContentId || String(partyContentId) !== playerContentId) {
      wpSocket.pickContent({
        contentId: playerContentId,
        mediaType: playerState.mediaType ?? 'movie',
        season: playerState.season ?? undefined,
        episode: playerState.episode ?? undefined,
        contentTitle: playerState.title || 'Untitled',
        contentPoster: playerState.poster ?? undefined,
      }).then(() => {
        // Start the party only after content is successfully picked
        if (useWatchPartyStore.getState().currentParty?.status === 'waiting') {
          wpSocket.startParty(0);
        }
      });
    } else if (currentParty.status === 'waiting') {
      // Content already picked — just start the party
      wpSocket.startParty(0);
    }
  }, [isHost, isInParty, currentParty, playerState.isOpen, playerState.contentId, playerState.mediaType, playerState.season, playerState.episode, playerState.title, playerState.poster, wpSocket.pickContent, wpSocket.startParty]);

  // ── Watch Party: Host closes player → pause party ───
  // When the host exits the video player while the party is playing,
  // send a pause event so members also pause and the UI reflects the
  // correct state instead of showing "Now playing" indefinitely.
  const prevPlayerOpenRef = useRef(false);
  useEffect(() => {
    const playerJustClosed = prevPlayerOpenRef.current && !playerState.isOpen;
    prevPlayerOpenRef.current = playerState.isOpen;

    if (!isHost || !isInParty || !currentParty) return;
    if (!playerJustClosed) return;
    if (currentParty.status !== 'playing' || !currentParty.playbackState.isPlaying) return;

    // Host closed the player — pause the party for everyone
    wpSocket.sendPause(currentParty.playbackState.currentTime);
  }, [isHost, isInParty, currentParty, playerState.isOpen, wpSocket.sendPause]);

  // ── Clear host-closed-player flag when leaving party ───
  useEffect(() => {
    if (!isInParty) hostClosedPlayerRef.current = false;
  }, [isInParty]);

  // ── When party ends while watching, close player and go home ──
  const prevIsInPartyRef = useRef(isInParty);
  useEffect(() => {
    const justLeftParty = prevIsInPartyRef.current && !isInParty;
    prevIsInPartyRef.current = isInParty;

    if (justLeftParty && playerState.isOpen) {
      handleClosePlayer();
      useNavigationStore.getState().navigate('home');
    }
  }, [isInParty, playerState.isOpen, handleClosePlayer]);

  const handleCompleted = useCallback(async () => {
    if (
      playerState.mediaType === 'tv' &&
      playerState.contentId != null &&
      playerState.season != null &&
      playerState.episode != null
    ) {
      const currentSeason = playerState.season;
      const currentEpisode = playerState.episode;
      const tvId = playerState.contentId;

      try {
        const { fetchSeasonDetail } = await import('@/services/api');
        const episodes = await fetchSeasonDetail(tvId, currentSeason);
        const nextEpisode = episodes.find((ep) => ep.episode_number === currentEpisode + 1);

        if (nextEpisode) {
          const title = playedItem?.title || playedItem?.name || 'Untitled';
          const embedUrl = buildEmbedUrl('tv', tvId, currentSeason, nextEpisode.episode_number);
          setPlayerState({
            isOpen: true,
            src: embedUrl,
            fallbackUrls: [],
            title: `${title} S${currentSeason} E${nextEpisode.episode_number}`,
            poster: playedItem?.backdrop_path
              ? `https://image.tmdb.org/t/p/w780${playedItem.backdrop_path}`
              : undefined,
            contentId: tvId,
            mediaType: 'tv',
            season: currentSeason,
            episode: nextEpisode.episode_number,
          });
          return;
        }
      } catch {
        // Failed to fetch season info — close player
      }
      handleClosePlayer();
    } else {
      handleClosePlayer();
    }
  }, [playerState, playedItem, buildEmbedUrl, handleClosePlayer]);

  const watchlistIdSet = useMemo(
    () => new Set(watchlistItems.map((i) => String(i.id))),
    [watchlistItems]
  );
  const isInList = useCallback(
    (id: string | number) => watchlistIdSet.has(String(id)),
    [watchlistIdSet]
  );

  const handleSearchSubmit = useCallback(
    (query: string) => {
      if (query.trim()) setSearchOpen(true);
    },
    [setSearchOpen]
  );

  const handleSearchNavigate = useCallback(
    (page: string, id?: string | number) => {
      setSearchOpen(false);
      if (id !== undefined) {
        navigate(page as never, id);
        window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
      } else {
        navigate(page as never);
      }
    },
    [setSearchOpen, navigate]
  );

  const navSearchQuery = isSearchOpen ? '' : '';
  const setNavSearchQuery = useCallback((q: string) => { void q; }, []);

  const handleDetailNavigate = useCallback(
    (item: ContentItem) => {
      const mediaType = (item.media_type === 'tv' ? 'tv' : 'movie') as 'movie' | 'tv';
      setPlayedItem(item);
      navigate('detail', item.id, mediaType);
      window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
    },
    [navigate]
  );

  // ── Splash screen (while auth + prefetch resolve) ──────
  if (!splashDone || status === 'loading') {
    return <SplashScreen />;
  }

  if (status === 'unauthenticated') {
    return (
      <div className="h-dvh bg-[#080808] flex flex-col select-none-native">
        <main className="flex-1 flex flex-col min-h-0">
          <LoginScreen />
        </main>
        <DownloadPanel
          isOpen={isDownloadPanelOpen}
          onClose={() => setDownloadPanelOpen(false)}
          onPlayDownload={handlePlayDownload}
        />
      </div>
    );
  }

  if (status === 'needs_profile') {
    return (
      <div className="h-dvh bg-[#080808] flex flex-col select-none-native">
        <main className="flex-1 flex flex-col min-h-0">
          <ProfileCompletionScreen />
        </main>
      </div>
    );
  }

  // ── Authenticated: render full app ───────────────────────
  return (
    <div
      className="bg-[#080808] text-[#F5F5F5] flex flex-col select-none-native overflow-hidden h-dvh"
    >
      {isOffline && (
        <div
          className="fixed top-0 left-0 right-0 z-[60] flex items-center justify-center gap-2 bg-[#1a1a0a]/95 border-b border-yellow-600/30 px-4 py-1.5 text-xs text-yellow-400/90 backdrop-blur-sm"
        >
          <WifiOff className="size-3.5" />
          <span>You&apos;re offline. Downloads and cached content available.</span>
        </div>
      )}

      {(currentPage === 'home' || currentPage === 'browse' || currentPage === 'movies' || currentPage === 'series') && (
        <Navbar
          onNavigate={handleNavigate}
          currentPage={currentPage}
          onSearchOpen={() => setSearchOpen(!isSearchOpen)}
          searchOpen={isSearchOpen}
          searchQuery={navSearchQuery}
          onSearchChange={setNavSearchQuery}
          onSearchSubmit={handleSearchSubmit}
          scrollRoot={mainRef}
        />
      )}

      <MobileNav onNavigate={handleNavigate} currentPage={currentPage} />

      <SearchOverlay
        isOpen={isSearchOpen}
        onClose={() => setSearchOpen(false)}
        onNavigate={handleSearchNavigate}
        onItemClick={handleItemClick}
        restoreQuery={navigatedFromSearch && !isSearchOpen ? savedSearchQuery : undefined}
        restoreResults={navigatedFromSearch && !isSearchOpen ? savedSearchResults : undefined}
        onRestoreConsumed={() => clearSavedSearch()}
      />

      <main
        ref={mainRef}
        className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden momentum-scroll"
        style={{
          paddingTop: (currentPage === 'home' || currentPage === 'browse' || currentPage === 'movies' || currentPage === 'series')
            ? '3.5rem'
            : '0.25rem',
          /* Bottom padding = nav pill height + small gap */
          paddingBottom: '62px',
          overscrollBehavior: 'none',
        }}
      >
        <AnimatePresence mode="wait" initial={false} custom={navDirection}>
          {currentPage === 'home' && (
            <motion.div
              key="home"
              custom={navDirection}
              initial={pageVariants.initial}
              animate={pageVariants.animate}
              exit={pageVariants.exit}
              variants={pageVariants}
              transition={iosTransition}
            >
              <HomePage onNavigate={handleNavigate} onItemClick={handleItemClick} onPlay={handlePlay} onAddList={handleAddList} isInList={isInList} scrollRoot={mainRef} />
            </motion.div>
          )}

          {(currentPage === 'browse' || currentPage === 'movies' || currentPage === 'series') && (
            <motion.div
              key="browse"
              custom={navDirection}
              initial="initial"
              animate="animate"
              exit="exit"
              variants={pageVariants}
              transition={iosTransition}
            >
              <BrowsePage onNavigate={handleNavigate} onItemClick={handleDetailNavigate} scrollRoot={mainRef} />
            </motion.div>
          )}

          {currentPage === 'mylist' && (
            <motion.div
              key="mylist"
              custom={navDirection}
              initial="initial"
              animate="animate"
              exit="exit"
              variants={pageVariants}
              transition={iosTransition}
            >
              <WatchlistPage onNavigate={handleNavigate} onItemClick={handleDetailNavigate} onRemove={removeWatchlist} />
            </motion.div>
          )}

          {currentPage === 'downloads' && (
            <motion.div
              key="downloads"
              custom={navDirection}
              initial="initial"
              animate="animate"
              exit="exit"
              variants={pageVariants}
              transition={iosTransition}
            >
              <DownloadsPage onNavigate={handleNavigate} onPlayDownload={handlePlayDownload} />
            </motion.div>
          )}

          {currentPage === 'profile' && (
            <motion.div
              key="profile"
              custom={navDirection}
              initial="initial"
              animate="animate"
              exit="exit"
              variants={pageVariants}
              transition={iosTransition}
            >
              <ProfilePage />
            </motion.div>
          )}

          {currentPage === 'detail' && selectedContentId != null && (
            <motion.div
              key={`detail-${selectedContentId}`}
              custom={navDirection}
              initial="initial"
              animate="animate"
              exit="exit"
              variants={detailPageVariants}
              transition={iosSpringTransition}
            >
              <DetailPage
                contentId={selectedContentId}
                mediaType={selectedMediaType}
                onBack={goBack}
                onPlay={handlePlayWithParams}
                onNavigateItem={handleItemClick}
                isInWatchlist={isInList}
                onToggleWatchlist={(id) => { if (playedItem) toggleWatchlist(playedItem); }}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      <DownloadPanel isOpen={isDownloadPanelOpen} onClose={() => setDownloadPanelOpen(false)} onPlayDownload={handlePlayDownload} />

      {/* ── Watch Party ──────────────────────────────────── */}
      <WatchPartyInviteOverlay
        onAccept={handleWpAcceptInvite}
        onReject={handleWpRejectInvite}
      />
      <WatchPartyRoom
        onPickContent={() => { if (isHost) { setWpContentPickerOpen(true); useWatchPartyStore.getState().setRoomVisible(false); } }}
        onStartParty={handleWpStartParty}
        onLeave={() => wpSocket.leaveRoom()}
        onEnd={() => wpSocket.endRoom()}
        onPttStart={() => wpSocket.sendPttStart()}
        onPttStop={() => wpSocket.sendPttStop()}
      />
      <WatchPartyContentPicker
        open={wpContentPickerOpen}
        onClose={() => setWpContentPickerOpen(false)}
        onPick={handleWpPickContent}
      />

      <AnimatePresence>
        {playerState.isOpen && (
          <VideoPlayer
            src={playerState.src}
            fallbackUrls={playerState.fallbackUrls}
            poster={playerState.poster}
            title={playerState.title}
            startTime={playerState.startTime}
            onClose={handleClosePlayer}
            onProgressUpdate={handleProgressUpdate}
            onCompleted={handleCompleted}
            contentId={playerState.contentId}
            mediaType={playerState.mediaType}
            season={playerState.season}
            episode={playerState.episode}
            subtitleUrls={playerState.subtitleUrls}
            subtitleTracks={playerState.subtitleTracks}
            useHls={playerState.useHls}
            hlsPlaybackId={playerState.hlsPlaybackId}
            fmp4Blob={playerState.fmp4Blob}
            autoPlay
            watchPartySync={isInParty ? {
              isHost,
              pausedBy: currentParty?.playbackState.pausedBy ?? null,
              onPause: wpSocket.sendPause,
              onPlay: wpSocket.sendPlay,
              onSeek: wpSocket.sendSeek,
              onSync: wpSocket.sendSync,
              pauseNotification,
              onPttStart: wpSocket.sendPttStart,
              onPttStop: wpSocket.sendPttStop,
              isPttActive,
              talkingMembers: new Set(talkingMembers.keys()),
              hostCurrentTime: currentParty?.playbackState.currentTime,
              hostIsPlaying: currentParty?.playbackState.isPlaying,
              members: currentParty?.members.map(m => ({ userId: m.userId, displayName: m.displayName, avatarUrl: m.avatarUrl, isHost: m.isHost })),
              localUserId: useAuthStore.getState().user?.id,
              partyStartTime: useWatchPartyStore.getState().partyStartTime,
              lastSyncSentAt: wpSocket.getLastSyncSentAt(),
            } : undefined}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
