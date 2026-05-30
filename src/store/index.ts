import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ContentItem, NavigationPage, WatchProgress } from '@/types/streaming';
import { getAuthToken } from '@/lib/session-manager';

export type NavDirection = 'forward' | 'back' | 'tab';

interface NavigationState {
  currentPage: NavigationPage;
  previousPage: NavigationPage | null;
  selectedContentId: string | number | null;
  selectedMediaType: 'movie' | 'tv';
  selectedSeasonNumber: number;
  direction: NavDirection;
  navigatedFromSearch: boolean;
  navigate: (page: NavigationPage, contentId?: string | number | null, mediaType?: 'movie' | 'tv') => void;
  goBack: () => void;
  setSeason: (season: number) => void;
  setNavigatedFromSearch: (value: boolean) => void;
}

const TAB_PAGES: NavigationPage[] = ['home', 'browse', 'downloads', 'mylist', 'profile'];

export const useNavigationStore = create<NavigationState>((set, get) => ({
  currentPage: 'home',
  previousPage: null,
  selectedContentId: null,
  selectedMediaType: 'movie',
  selectedSeasonNumber: 1,
  direction: 'tab' as NavDirection,
  navigatedFromSearch: false,
  navigate: (page, contentId = null, mediaType) => {
    const current = get().currentPage;
    // Determine direction: push to detail = forward, back from detail = back, else tab switch
    let direction: NavDirection = 'tab';
    if (page === 'detail') {
      direction = 'forward';
    } else if (current === 'detail') {
      direction = 'back';
    }
    set({
      previousPage: current,
      currentPage: page,
      selectedContentId: contentId,
      selectedMediaType: mediaType ?? get().selectedMediaType,
      selectedSeasonNumber: 1,
      direction,
      // Clear search context when navigating to a non-detail page
      navigatedFromSearch: page === 'detail' ? get().navigatedFromSearch : false,
    });
  },
  goBack: () => {
    const prev = get().previousPage;
    const cameFromSearch = get().navigatedFromSearch;
    set({
      currentPage: prev || 'home',
      previousPage: 'home',
      selectedContentId: prev === 'detail' ? get().selectedContentId : null,
      direction: 'back' as NavDirection,
      // Keep navigatedFromSearch true so StreamVaultApp can re-open search overlay
      navigatedFromSearch: cameFromSearch,
    });
  },
  setSeason: (season) => set({ selectedSeasonNumber: season }),
  setNavigatedFromSearch: (value) => set({ navigatedFromSearch: value }),
}));

interface WatchlistState {
  items: ContentItem[];
  addItem: (item: ContentItem) => void;
  removeItem: (id: string | number) => void;
  toggleItem: (item: ContentItem) => void;
  isInList: (id: string | number) => boolean;
  fetchFromServer: (token: string) => Promise<void>;
  syncFromServer: () => Promise<void>;
  pushToServer: (token: string) => Promise<void>;
  /** Pending sync counter — prevents rapid mutations from silently dropping server syncs.
   *  Unlike a boolean lock, a counter ensures every mutation gets synced eventually. */
  _pendingSyncs: number;
}

export const useWatchlistStore = create<WatchlistState>()(
  persist(
    (set, get) => ({
      items: [],
      _pendingSyncs: 0,

      addItem: (item) => {
        set((s) => ({ items: [...s.items.filter((i) => String(i.id) !== String(item.id)), item] }));
        get()._syncToServerBackground();
      },

      removeItem: (id) => {
        set((s) => ({ items: s.items.filter((i) => String(i.id) !== String(id)) }));
        get()._syncToServerBackground();
      },

      toggleItem: (item) => {
        const { items } = get();
        if (items.some((i) => String(i.id) === String(item.id))) {
          set({ items: items.filter((i) => String(i.id) !== String(item.id)) });
        } else {
          set({ items: [...items, item] });
        }
        get()._syncToServerBackground();
      },

      isInList: (id) => get().items.some((i) => String(i.id) === String(id)),

      /** Fire-and-forget sync to server after local mutation.
       *  Uses a pending counter (not boolean) so rapid mutations don't silently
       *  drop syncs. Each mutation increments the counter; the sync loop
       *  decrements after push and re-pushes until the counter reaches zero. */
      _syncToServerBackground: async () => {
        const current = get();
        set({ _pendingSyncs: current._pendingSyncs + 1 });

        // If a sync is already in-flight, just increment — it will re-check
        if (current._pendingSyncs > 1) return;

        try {
          let pending = get()._pendingSyncs;
          while (pending > 0) {
            const token = await getAuthToken();
            if (!token) break;
            await get().pushToServer(token);
            pending = get()._pendingSyncs;
            // Only clear if no new mutations arrived during the push
            if (pending <= 1) {
              set({ _pendingSyncs: 0 });
              break;
            }
            // New mutations arrived — decrement by 1 (this sync consumed one)
            // and loop to push the updated state
            set({ _pendingSyncs: pending - 1 });
          }
        } catch {
          // Sync failed — localStorage is the fallback. Reset counter
          // so the next mutation will trigger a fresh sync attempt.
          set({ _pendingSyncs: 0 });
        }
      },

      /** Fetch watchlist from server and merge with local */
      fetchFromServer: async (token) => {
        try {
          const res = await fetch('/api/watchlist', {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (!res.ok) {
            // Token might have gone stale — refresh and retry once
            const fresh = await getAuthToken();
            if (!fresh || fresh === token) return;
            const retry = await fetch('/api/watchlist', {
              headers: { Authorization: `Bearer ${fresh}` },
            });
            if (!retry.ok) return;
            const retryJson = await retry.json();
            if (retryJson.tableMissing) return;
            const retryItems = (retryJson.items ?? []) as ContentItem[];
            if (retryItems.length > 0) set({ items: retryItems });
            return;
          }
          const json = await res.json();
          if (json.tableMissing) return;
          const serverItems = (json.items ?? []) as ContentItem[];
          if (serverItems.length > 0) {
            set({ items: serverItems });
          }
        } catch { /* silent — localStorage is the fallback */ }
      },

      /** Fetch from server using current session (no external token needed) */
      syncFromServer: async () => {
        const token = await getAuthToken();
        if (!token) return;
        await get().fetchFromServer(token);
      },

      /** Push current local watchlist to server (full replace) */
      pushToServer: async (token) => {
        try {
          const res = await fetch('/api/watchlist', {
            method: 'PUT',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ items: get().items }),
          });
          if (!res.ok) {
            // Token might have gone stale mid-flight — refresh and retry once
            const fresh = await getAuthToken();
            if (!fresh || fresh === token) return;
            await fetch('/api/watchlist', {
              method: 'PUT',
              headers: {
                Authorization: `Bearer ${fresh}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ items: get().items }),
            });
          }
        } catch { /* silent — localStorage is the fallback */ }
      },
    }),
    { name: 'streamvault-watchlist', partialize: (s) => ({ items: s.items }) }
  )
);

/* Auth token helper re-exported from canonical location (session-manager.ts).
   Imported locally (above) so store internals can call getAuthToken().
   Re-exported here so other modules import from store. */
export { getAuthToken };

const MAX_PROGRESS_ENTRIES = 100;

interface ProgressState {
  progress: WatchProgress[];
  updateProgress: (entry: WatchProgress) => void;
  getProgress: (contentId: string | number, season?: number, episode?: number) => WatchProgress | undefined;
  removeProgress: (contentId: string | number, season?: number, episode?: number) => void;
}

export const useProgressStore = create<ProgressState>()(
  persist(
    (set, get) => ({
      progress: [],
      updateProgress: (entry) =>
        set((s) => {
          const filtered = s.progress.filter(
            (p) =>
              !(
                String(p.contentId) === String(entry.contentId) &&
                p.season === entry.season &&
                p.episode === entry.episode
              )
          );
          const updated = [...filtered, entry];
          // Cap at MAX_PROGRESS_ENTRIES — remove oldest entries first
          // to prevent unbounded localStorage growth over time
          if (updated.length > MAX_PROGRESS_ENTRIES) {
            updated.splice(0, updated.length - MAX_PROGRESS_ENTRIES);
          }
          return { progress: updated };
        }),
      getProgress: (contentId, season, episode) =>
        get().progress.find(
          (p) =>
            String(p.contentId) === String(contentId) &&
            p.season === season &&
            p.episode === episode
        ),
      removeProgress: (contentId, season, episode) =>
        set((s) => ({
          progress: s.progress.filter(
            (p) =>
              !(
                String(p.contentId) === String(contentId) &&
                p.season === season &&
                p.episode === episode
              )
          ),
        })),
    }),
    { name: 'streamvault-progress' }
  )
);

interface UIState {
  searchQuery: string;
  isSearchOpen: boolean;
  isDownloadPanelOpen: boolean;
  savedSearchQuery: string;
  savedSearchResults: ContentItem[];
  setSearchQuery: (q: string) => void;
  setSearchOpen: (open: boolean) => void;
  setDownloadPanelOpen: (open: boolean) => void;
  saveSearchState: (query: string, results: ContentItem[]) => void;
  clearSavedSearch: () => void;
}

export const useUIStore = create<UIState>((set) => ({
  searchQuery: '',
  isSearchOpen: false,
  isDownloadPanelOpen: false,
  savedSearchQuery: '',
  savedSearchResults: [],
  setSearchQuery: (q) => set({ searchQuery: q }),
  setSearchOpen: (open) => set({ isSearchOpen: open }),
  setDownloadPanelOpen: (open) => set({ isDownloadPanelOpen: open }),
  saveSearchState: (query, results) => set({ savedSearchQuery: query, savedSearchResults: results }),
  clearSavedSearch: () => set({ savedSearchQuery: '', savedSearchResults: [] }),
}));

// ── Auth Store ─────────────────────────────────────────────
// Supabase-backed authentication + profile state.
// Session is persisted by Supabase client in localStorage.
// Profile is fetched from DB on session restore.

import type { User, Session } from '@supabase/supabase-js';
import type { ProfileRow } from '@/types/supabase';

export type AuthStatus = 'loading' | 'unauthenticated' | 'authenticated' | 'needs_profile';

const OFFLINE_PROFILE_KEY = 'streamvault-cached-profile';
const SUPABASE_SESSION_KEY = 'streamvault-auth-token';

function cacheProfileOffline(profile: ProfileRow | null) {
  if (typeof window === 'undefined') return;
  if (profile) {
    try { localStorage.setItem(OFFLINE_PROFILE_KEY, JSON.stringify(profile)); } catch { /* ignore */ }
  } else {
    try { localStorage.removeItem(OFFLINE_PROFILE_KEY); } catch { /* ignore */ }
  }
}

function getCachedProfile(): ProfileRow | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(OFFLINE_PROFILE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

interface AuthState {
  status: AuthStatus;
  user: User | null;
  session: Session | null;
  profile: ProfileRow | null;
  isOffline: boolean;

  // Actions
  setAuth: (user: User | null, session: Session | null) => void;
  setProfile: (profile: ProfileRow | null) => void;
  setStatus: (status: AuthStatus) => void;
  setOffline: (offline: boolean) => void;
  bootstrapFromCache: () => void;
  logout: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set, get) => ({
    status: 'loading' as AuthStatus,
    user: null,
    session: null,
    profile: null,
    isOffline: false,

    setAuth: (user, session) => set({ user, session }),
    setProfile: (profile) => {
      // Only cache non-null profiles — don't delete the cached profile
      // when a DB fetch fails (RLS/406/network). Only logout() should clear it.
      if (profile) {
        cacheProfileOffline(profile);
        // Cache avatar image blob for offline display (fire-and-forget)
        if (profile.avatar_url) {
          const userId = get().user?.id;
          if (userId) {
            (async () => {
              try {
                const { saveAvatar } = await import('@/lib/download-storage');
                const resp = await fetch(profile.avatar_url);
                if (resp.ok) {
                  const blob = await resp.blob();
                  await saveAvatar(userId, blob);
                }
              } catch { /* avatar caching failed — non-critical */ }
            })();
          }
        }
      }
      set({ profile });
    },
    setStatus: (status) => set({ status }),
    setOffline: (isOffline) => set({ isOffline }),
    bootstrapFromCache: () => {
      if (typeof window === 'undefined') return;
      try {
        const sessionRaw = localStorage.getItem(SUPABASE_SESSION_KEY);
        if (!sessionRaw) { set({ status: 'unauthenticated' }); return; }
        const session = JSON.parse(sessionRaw);
        // Validate session structure — must have access_token and a user object
        // with user_metadata. Corrupted data should not gate the user.
        if (!session || typeof session !== 'object') {
          set({ status: 'unauthenticated' }); return;
        }
        const accessToken = session?.access_token;
        if (!accessToken || typeof accessToken !== 'string') {
          set({ status: 'unauthenticated' }); return;
        }
        // Validate user_metadata is an object (not null/undefined/corrupted)
        const userMeta = session?.user?.user_metadata;
        const metaCompleted = !!(userMeta && typeof userMeta === 'object' && userMeta.profile_completed);

        const cached = getCachedProfile();
        const cachedHasName = cached && typeof cached.display_name === 'string' && cached.display_name.trim().length > 0;

        if (cachedHasName || metaCompleted) {
          set({ status: 'authenticated', profile: cached, isOffline: !navigator.onLine });
        } else {
          // Session exists but no proof of profile completion.
          // Never stay at loading — set needs_profile so the user
          // can complete their profile immediately. validateSession()
          // will correct to authenticated if DB returns a profile.
          set({ status: 'needs_profile', isOffline: !navigator.onLine });
        }
      } catch {
        // JSON parse error or localStorage access failure — treat as unauthenticated
        set({ status: 'unauthenticated' });
      }
    },
    logout: async () => {
      try {
        // Destroy session in DB BEFORE signing out of Supabase.
        const { destroySession } = await import('@/lib/session-manager');
        await destroySession();
      } catch {
        // destroySession failed — still clear local state
      }

      // ── Clear ALL localStorage auth artifacts BEFORE anything else ──
      // This is the definitive kill. supabase.auth.signOut() can fail
      // silently (network error, GoTrue race, autoRefreshToken re-writing).
      // If it fails, the stale token persists and bootstrapFromCache()
      // restores auth state on the next refresh → user appears logged in.
      // By clearing localStorage explicitly, bootstrapFromCache() always
      // finds nothing, regardless of whether signOut() succeeds.
      try {
        if (typeof window !== 'undefined') {
          localStorage.removeItem(SUPABASE_SESSION_KEY);
          localStorage.removeItem('sv_device_session_id');
        }
      } catch { /* localStorage access failure — non-critical */ }

      // Clear cached profile (already cleared localStorage above)
      cacheProfileOffline(null);

      // Clear Zustand volatile state (not persisted — in-memory only)
      set({ user: null, session: null, profile: null, status: 'unauthenticated', isOffline: false });

      // Stop GoTrue autoRefreshToken timer + clear in-memory session.
      // Must happen AFTER localStorage is cleared to prevent a concurrent
      // refresh from re-writing the token between our removeItem() and here.
      try {
        const { supabase } = await import('@/lib/supabase');
        await supabase.auth.signOut({ scope: 'local' });
      } catch {
        // signOut failed — localStorage already cleared, state already wiped
      }

      // Null the singleton so the next getSession() creates a fresh client
      // with no in-memory session cache. Without this, the old client's
      // getSession() could return a stale in-memory session.
      try {
        const { resetSupabaseClient } = await import('@/lib/supabase');
        resetSupabaseClient();
      } catch { /* non-critical */ }
    },
}));

export { getCachedProfile };

// ── Download Store ─────────────────────────────────────────
import type { DownloadTask } from '@/lib/hls-downloader';
import { deleteBlob as deleteBlobFromStorage, deletePoster } from '@/lib/download-storage';

// Per-task progress throttle: max ~4 updates/sec to avoid flooding Zustand.
// Each update creates a new tasks[] → triggers every subscriber (DownloadBadge
// on every card, DownloadPanel, DownloadButton). Without throttling, a download
// at 5MB/sec fires 30-60 state updates per second, re-rendering the entire tree.
const _progressTimers = new Map<string, ReturnType<typeof setTimeout>>();
const _progressPending = new Map<string, Partial<DownloadTask>>();

function scheduleProgressUpdate(
  id: string,
  updates: Partial<DownloadTask>,
  set: (fn: (s: DownloadState) => Partial<DownloadState>) => void,
) {
  _progressPending.set(id, { ...(_progressPending.get(id) ?? {}), ...updates });

  // If no timer is running, schedule one (~250ms = ~4 updates/sec)
  if (!_progressTimers.has(id)) {
    _progressTimers.set(id, setTimeout(() => {
      const pending = _progressPending.get(id);
      _progressTimers.delete(id);
      _progressPending.delete(id);
      if (!pending) return;
      set((s) => ({
        tasks: s.tasks.map((t) => (t.id === id ? { ...t, ...pending } : t)),
      }));
    }, 250));
  }
}

// Final flush — called when download completes/errors (bypass throttle)
function flushProgressUpdate(
  id: string,
  updates: Partial<DownloadTask>,
  set: (fn: (s: DownloadState) => Partial<DownloadState>) => void,
) {
  const timer = _progressTimers.get(id);
  if (timer) {
    clearTimeout(timer);
    _progressTimers.delete(id);
  }
  const pending = _progressPending.get(id) ?? {};
  _progressPending.delete(id);
  set((s) => ({
    tasks: s.tasks.map((t) => (t.id === id ? { ...t, ...pending, ...updates } : t)),
  }));
}

interface DownloadState {
  tasks: DownloadTask[];
  addTask: (task: DownloadTask) => void;
  updateTask: (id: string, updates: Partial<DownloadTask>) => void;
  removeTask: (id: string) => void;
  getTask: (id: string) => DownloadTask | undefined;
  getTaskForContent: (contentId: string | number, season?: number, episode?: number) => DownloadTask | undefined;
  isContentDownloaded: (contentId: string | number) => boolean;
  isContentDownloading: (contentId: string | number) => boolean;
  getTotalDownloadedBytes: () => number;
}

export const useDownloadStore = create<DownloadState>()(
  persist(
    (set, get) => ({
      tasks: [],
      addTask: (task) =>
        set((s) => {
          // Replace existing task for same content+season+episode
          const filtered = s.tasks.filter(
            (t) =>
              !(
                String(t.contentId) === String(task.contentId) &&
                t.season === task.season &&
                t.episode === task.episode
              )
          );
          return { tasks: [...filtered, task] };
        }),
      updateTask: (id, updates) => {
        // Terminal states (completed/error) bypass throttle — flush immediately
        if (updates.status === 'completed' || updates.status === 'error') {
          flushProgressUpdate(id, updates, set);
          return;
        }
        // In-flight progress updates: throttle to ~4/sec
        if (updates.status === 'downloading') {
          scheduleProgressUpdate(id, updates, set);
          return;
        }
        // Non-progress updates (status changes like 'pending'): apply immediately
        set((s) => ({
          tasks: s.tasks.map((t) => (t.id === id ? { ...t, ...updates } : t)),
        }));
      },
      removeTask: (id) =>
        set((s) => {
          // Find the task being removed to get its contentId for poster cleanup
          const task = s.tasks.find((t) => t.id === id);
          const contentId = task?.contentId;
          // Clean up IndexedDB blob (fire-and-forget)
          deleteBlobFromStorage(id).catch(() => {});
          // Clean up poster if no other tasks share the same contentId
          if (contentId !== undefined) {
            const otherTasksWithSameContent = s.tasks.filter(
              (t) => t.id !== id && String(t.contentId) === String(contentId)
            );
            if (otherTasksWithSameContent.length === 0) {
              deletePoster(contentId).catch(() => {});
            }
          }
          return { tasks: s.tasks.filter((t) => t.id !== id) };
        }),
      getTask: (id) => get().tasks.find((t) => t.id === id),
      getTaskForContent: (contentId, season, episode) =>
        get().tasks.find(
          (t) =>
            String(t.contentId) === String(contentId) &&
            t.season === season &&
            t.episode === episode
        ),
      isContentDownloaded: (contentId) =>
        get().tasks.some(
          (t) => String(t.contentId) === String(contentId) && t.status === 'completed'
        ),
      isContentDownloading: (contentId) =>
        get().tasks.some(
          (t) =>
            String(t.contentId) === String(contentId) &&
            (t.status === 'downloading' || t.status === 'pending')
        ),
      getTotalDownloadedBytes: () =>
        get()
          .tasks.filter((t) => t.status === 'completed')
          .reduce((sum, t) => sum + t.downloadedBytes, 0),
    }),
    {
      name: 'streamvault-downloads',
      // Only persist the tasks array (data only — no functions).
      // Spreading ...state includes functions which can interfere with
      // persist middleware's internal diffing and merge behavior.
      partialize: (state) => ({
        tasks: state.tasks.map((t) => ({
          ...t,
          blob: undefined,
        })),
      }),
      // Custom merge: always merge tasks, never wipe in-flight downloads.
      // Default merge is shallow ({...current, ...persisted}) which is fine,
      // but we keep this explicit to prevent future regressions.
      merge: (persisted, current) => {
        const pTasks = (persisted as Partial<DownloadState>)?.tasks;
        return {
          ...current,
          ...(pTasks !== undefined ? { tasks: pTasks as DownloadTask[] } : {}),
        };
      },
    }
  )
);

// ── Settings Store ─────────────────────────────────────────
// Device-level preferences persisted in localStorage.
// These are client-side only — not synced to Supabase profiles table
// because they're device-specific (e.g., download folder only makes
// sense on the current device/browser).

interface SettingsState {
  /** Preferred subtitle language codes for automatic offline download.
   *  When downloading a video, only subtitle tracks matching these
   *  languages are downloaded. Empty array = download all available. */
  preferredSubtitles: string[];

  /** Display name of the user's chosen download folder (File System Access API).
   *  null = not configured → downloads go to IndexedDB only. */
  downloadFolderName: string | null;

  // Actions
  setPreferredSubtitles: (langs: string[]) => void;
  setDownloadFolderName: (name: string | null) => void;
  togglePreferredSubtitle: (lang: string) => void;
  isSubtitlePreferred: (lang: string) => boolean;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      preferredSubtitles: [],
      downloadFolderName: null,

      setPreferredSubtitles: (langs) => set({ preferredSubtitles: langs }),
      setDownloadFolderName: (name) => set({ downloadFolderName: name }),
      togglePreferredSubtitle: (lang) => {
        const current = get().preferredSubtitles;
        if (current.includes(lang)) {
          set({ preferredSubtitles: current.filter((l) => l !== lang) });
        } else {
          set({ preferredSubtitles: [...current, lang] });
        }
      },
      isSubtitlePreferred: (lang) => {
        const { preferredSubtitles } = get();
        // Empty list = all languages preferred (download everything available)
        return preferredSubtitles.length === 0 || preferredSubtitles.includes(lang);
      },
    }),
    {
      name: 'streamvault-settings',
      partialize: (s) => ({
        preferredSubtitles: s.preferredSubtitles,
        downloadFolderName: s.downloadFolderName,
      }),
    }
  )
);
