import type { ContentItem, ContentDetail, StreamSource, EpisodeDetail, DownloadLink } from '@/types/streaming';

const API_BASE = '/api/stream';
const FETCH_TIMEOUT = 15_000; // 15 seconds — bail on unresponsive API

// ── Lightweight in-memory response cache ─────────────────────
// Reduces duplicate network requests when navigating between pages.
// Page-1 content (trending, popular, top-rated, genres) is cached
// for CONTENT_CACHE_TTL ms. Subsequent calls within that window
// return cached data immediately.
// Stream sources and search are NOT cached (must be fresh).

const CONTENT_CACHE_TTL = 60_000; // 1 minute — balances freshness with dedup
const contentCache = new Map<string, { data: unknown; ts: number }>();

function getCached<T>(key: string): T | null {
  const entry = contentCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CONTENT_CACHE_TTL) {
    contentCache.delete(key);
    return null;
  }
  return entry.data as T;
}

function setCache(key: string, data: unknown): void {
  // Evict oldest entries if cache grows beyond 50 entries
  if (contentCache.size >= 50) {
    const oldestKey = contentCache.keys().next().value;
    if (oldestKey !== undefined) contentCache.delete(oldestKey);
  }
  contentCache.set(key, { data, ts: Date.now() });
}

// ── In-flight request deduplication ───────────────────────────
// Prevents duplicate concurrent fetches for the same URL.
// If a request is already in-flight, subsequent callers get
// the same Promise instead of firing a new request.

const inflightRequests = new Map<string, Promise<unknown>>();

function deduplicatedFetch<T>(url: string, fetcher: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const existing = inflightRequests.get(url);
  if (existing) return existing as Promise<T>;

  const promise = fetcher().finally(() => {
    inflightRequests.delete(url);
  });

  // If the caller aborts, don't invalidate the shared promise for other callers
  inflightRequests.set(url, promise);
  return promise;
}

// ── Internal fetch wrapper with timeout + optional abort ────

function apiFetch(url: string, signal?: AbortSignal): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

  // Link external signal so component unmount can abort this fetch
  const onExternalAbort = () => controller.abort();
  signal?.addEventListener('abort', onExternalAbort, { once: true });

  return fetch(url, { signal: controller.signal }).finally(() => {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onExternalAbort);
  });
}

// ── TMDB Image Helpers ──────────────────────────────────────────

function getImageUrl(path: string | null | undefined, size: string = 'w500'): string {
  if (!path) return '/placeholder-poster.svg';
  return `https://image.tmdb.org/t/p/${size}${path}`;
}

function getBackdropUrl(path: string | null | undefined, size: string = 'original'): string {
  if (!path) return '';
  return `https://image.tmdb.org/t/p/${size}${path}`;
}

// ── Stream Source Response ───────────────────────────────────────

export interface StreamSourceResponse {
  /** Primary embed URL (vidsrc.to) for iframe player */
  embedUrl: string;
  /** Fallback embed URLs on other domains */
  fallbackUrls: string[];
  /** Direct HLS/MP4 stream URLs (best-effort, may be empty) */
  sources: StreamSource[];
  /** EgyBest download links with quality metadata */
  downloadLinks?: DownloadLink[];
  /** Maps source URL → provider name */
  providerMap?: Record<string, string>;
  /** IMDB ID for this content (used for subtitle lookup) */
  imdbId?: string | null;
}

// ── Response validation ──────────────────────────────────────────

function ensureArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? value : [];
}

// ── TMDB Content Fetchers ────────────────────────────────────────

export async function fetchTrending(page: number = 1, type: 'all' | 'movie' | 'tv' = 'all', signal?: AbortSignal): Promise<ContentItem[]> {
  const cacheKey = `trending:${page}:${type}`;
  const cached = getCached<ContentItem[]>(cacheKey);
  if (cached) return cached;
  return deduplicatedFetch(cacheKey, async () => {
    const res = await apiFetch(`${API_BASE}/trending?page=${page}&type=${type}`, signal);
    if (!res.ok) throw new Error('Failed to fetch trending');
    const data = await res.json();
    const items = ensureArray<ContentItem>(data.results);
    setCache(cacheKey, items);
    return items;
  }, signal);
}

export async function fetchPopular(page: number = 1, type: 'movie' | 'tv' = 'movie', signal?: AbortSignal): Promise<ContentItem[]> {
  const cacheKey = `popular:${page}:${type}`;
  const cached = getCached<ContentItem[]>(cacheKey);
  if (cached) return cached;
  return deduplicatedFetch(cacheKey, async () => {
    const res = await apiFetch(`${API_BASE}/popular?page=${page}&type=${type}`, signal);
    if (!res.ok) throw new Error('Failed to fetch popular');
    const data = await res.json();
    const items = ensureArray<ContentItem>(data.results);
    setCache(cacheKey, items);
    return items;
  }, signal);
}

export async function fetchTopRated(page: number = 1, type: 'movie' | 'tv' = 'movie', signal?: AbortSignal): Promise<ContentItem[]> {
  const cacheKey = `top-rated:${page}:${type}`;
  const cached = getCached<ContentItem[]>(cacheKey);
  if (cached) return cached;
  return deduplicatedFetch(cacheKey, async () => {
    const res = await apiFetch(`${API_BASE}/top-rated?page=${page}&type=${type}`, signal);
    if (!res.ok) throw new Error('Failed to fetch top rated');
    const data = await res.json();
    const items = ensureArray<ContentItem>(data.results);
    setCache(cacheKey, items);
    return items;
  }, signal);
}

export async function fetchByGenre(genreId: number, page: number = 1, type: 'movie' | 'tv' = 'movie', signal?: AbortSignal): Promise<ContentItem[]> {
  const cacheKey = `genre:${genreId}:${page}:${type}`;
  const cached = getCached<ContentItem[]>(cacheKey);
  if (cached) return cached;
  return deduplicatedFetch(cacheKey, async () => {
    const res = await apiFetch(`${API_BASE}/genre/${genreId}?page=${page}&type=${type}`, signal);
    if (!res.ok) throw new Error('Failed to fetch by genre');
    const data = await res.json();
    const items = ensureArray<ContentItem>(data.results);
    setCache(cacheKey, items);
    return items;
  }, signal);
}

export async function fetchNewReleases(signal?: AbortSignal): Promise<ContentItem[]> {
  const cacheKey = 'new-releases:1';
  const cached = getCached<ContentItem[]>(cacheKey);
  if (cached) return cached;
  return deduplicatedFetch(cacheKey, async () => {
    const res = await apiFetch(`${API_BASE}/new-releases`, signal);
    if (!res.ok) throw new Error('Failed to fetch new releases');
    const data = await res.json();
    const items = ensureArray<ContentItem>(data.results);
    setCache(cacheKey, items);
    return items;
  }, signal);
}

export async function searchContent(query: string, page: number = 1, signal?: AbortSignal): Promise<ContentItem[]> {
  const res = await apiFetch(`${API_BASE}/search?q=${encodeURIComponent(query)}&page=${page}`, signal);
  if (!res.ok) throw new Error('Failed to search');
  const data = await res.json();
  return ensureArray<ContentItem>(data.results);
}

export async function fetchContentDetail(id: string | number, type: 'movie' | 'tv', signal?: AbortSignal): Promise<ContentDetail> {
  const res = await apiFetch(`${API_BASE}/detail/${id}?type=${type}`, signal);
  if (!res.ok) throw new Error('Failed to fetch detail');
  return res.json();
}

export async function fetchSeasonDetail(
  tvId: string | number,
  seasonNumber: number,
  signal?: AbortSignal,
): Promise<EpisodeDetail[]> {
  const res = await apiFetch(`${API_BASE}/season/${tvId}/${seasonNumber}`, signal);
  if (!res.ok) throw new Error('Failed to fetch season');
  const data = await res.json();
  return ensureArray<EpisodeDetail>(data.episodes);
}

const GENRES_CACHE_KEY = 'sv_genres_cache';
const GENRES_CACHE_TTL = 3_600_000; // 1 hour

function loadGenresCache(type: 'movie' | 'tv'): { data: { id: number; name: string }[]; ts: number } | null {
  try {
    const raw = localStorage.getItem(`${GENRES_CACHE_KEY}:${type}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (Date.now() - parsed.ts > GENRES_CACHE_TTL) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function fetchGenres(type: 'movie' | 'tv', signal?: AbortSignal): Promise<{ id: number; name: string }[]> {
  // Use type-specific cache when available to reduce TMDB dependency.
  // CRITICAL: movie and TV genres are DIFFERENT lists — caching without a type key
  // returned movie genres when TV genres were requested (data corruption bug).
  const cached = loadGenresCache(type);
  if (cached) return cached.data;

  const res = await apiFetch(`${API_BASE}/genres?type=${type}`, signal);
  if (!res.ok) throw new Error('Failed to fetch genres');
  const data = await res.json();
  const genres = ensureArray<{ id: number; name: string }>(data.genres);

  // Persist to localStorage with type-specific key
  if (genres.length > 0) {
    try {
      localStorage.setItem(`${GENRES_CACHE_KEY}:${type}`, JSON.stringify({ data: genres, ts: Date.now() }));
    } catch {
      // localStorage full or unavailable — non-critical
    }
  }

  return genres;
}

// ── Stream Sources ───────────────────────────────────────────────

/**
 * Fetches stream sources for a given TMDB ID.
 *
 * Returns a `StreamSourceResponse` containing:
 *   - `embedUrl`     — primary iframe embed URL (vaplayer.ru)
 *   - `fallbackUrls` — backup embed URLs on other VidAPI domains
 *   - `sources`      — direct HLS/MP4 URLs (if available)
 */
export async function fetchStreamSources(
  tmdbId: string | number,
  type: 'movie' | 'tv',
  season?: number,
  episode?: number,
  signal?: AbortSignal,
): Promise<StreamSourceResponse> {
  const params = new URLSearchParams({ id: String(tmdbId), type });
  if (season !== undefined) params.set('season', String(season));
  if (episode !== undefined) params.set('episode', String(episode));

  const res = await apiFetch(`${API_BASE}/source?${params}`, signal);
  if (!res.ok) throw new Error('Failed to fetch stream sources');
  const data = await res.json();
  return {
    embedUrl: data.embedUrl || '',
    fallbackUrls: ensureArray<string>(data.fallbackUrls),
    sources: ensureArray<StreamSource>(data.sources),
    downloadLinks: data.downloadLinks ? ensureArray<DownloadLink>(data.downloadLinks) : undefined,
    providerMap: data.providerMap || undefined,
    imdbId: data.imdbId || null,
  };
}

// ── VidAPI Catalog Endpoints ─────────────────────────────────────

/**
 * Latest movies listing from vidapi.ru
 * Proxied through /api/stream/catalog/movies
 */
export async function fetchLatestMovies(page: number = 1): Promise<unknown> {
  const res = await apiFetch(`${API_BASE}/catalog/movies?page=${page}`);
  if (!res.ok) throw new Error('Failed to fetch latest movies');
  return res.json();
}

/**
 * Latest TV shows listing from vidapi.ru
 * Proxied through /api/stream/catalog/tvshows
 */
export async function fetchLatestTVShows(page: number = 1): Promise<unknown> {
  const res = await apiFetch(`${API_BASE}/catalog/tvshows?page=${page}`);
  if (!res.ok) throw new Error('Failed to fetch latest TV shows');
  return res.json();
}

/**
 * Latest episodes listing from vidapi.ru
 * Proxied through /api/stream/catalog/episodes
 */
export async function fetchLatestEpisodes(page: number = 1): Promise<unknown> {
  const res = await apiFetch(`${API_BASE}/catalog/episodes?page=${page}`);
  if (!res.ok) throw new Error('Failed to fetch latest episodes');
  return res.json();
}

export { getImageUrl, getBackdropUrl };
