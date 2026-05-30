/**
 * TMDB API utility — authenticated with Read Access Token (v4).
 *
 * Zero runtime-specific dependencies. Uses only standard fetch + JSON.parse.
 * Vercel's Node.js runtime auto-decompresses gzip responses from fetch().
 *
 * Gracefully handles missing API keys: returns empty results instead of
 * making requests that will 401, so the app never crashes on missing env vars.
 */

const TMDB_API_KEY = process.env.TMDB_API_KEY || '';
const TMDB_READ_ACCESS_TOKEN = process.env.TMDB_READ_ACCESS_TOKEN || '';
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';
const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p';

/** Whether TMDB API credentials are configured */
export const isTmdbConfigured = !!(TMDB_API_KEY || TMDB_READ_ACCESS_TOKEN);

export function getTmdbUrl(path: string, params: Record<string, string> = {}): string {
  const url = new URL(`${TMDB_BASE_URL}${path}`);
  if (TMDB_API_KEY) {
    url.searchParams.set('api_key', TMDB_API_KEY);
  }
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') {
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

/**
 * Returns an empty TMDB-style response for the given path.
 * Used when API keys are not configured so routes return 200 with empty data.
 */
function emptyTmdbResponse<T>(path: string): T {
  // Most TMDB list endpoints return { results: [], total_pages: 0, total_results: 0 }
  // Detail endpoints return a single object — but we can't guess the shape,
  // so we return a minimal stub that won't crash the UI.
  if (path.includes('/list') || path.includes('/search') || path.includes('/trending') ||
      path.includes('/popular') || path.includes('/top_rated') || path.includes('/now_playing') ||
      path.includes('/on_the_air') || path.includes('/discover') || path.includes('/similar') ||
      path.includes('/credits') || path.includes('/videos')) {
    return { results: [], total_pages: 0, total_results: 0 } as T;
  }
  // Genre list endpoint
  if (path.includes('/genre')) {
    return { genres: [] } as T;
  }
  // Season endpoint
  if (path.includes('/season/')) {
    return { id: 0, name: '', season_number: 0, episodes: [] } as T;
  }
  // Fallback: empty object
  return {} as T;
}

/**
 * Fetch from TMDB API with retry + timeout.
 *
 * Retryable status codes: 429 (rate limit), 500, 502, 503, 504.
 * Non-retryable: 401 (bad key), 404 (genuinely not found), 405.
 *
 * On final failure, throws TmdbError with the actual TMDB status code
 * so callers can differentiate between "content doesn't exist" (404)
 * and "TMDB is temporarily down" (429/5xx).
 */
const TMDB_MAX_RETRIES = 2;
const TMDB_TIMEOUT_MS = 10_000;
const TMDB_RETRYABLE = new Set([429, 500, 502, 503, 504]);

export class TmdbError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'TmdbError';
    this.status = status;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function tmdbFetch<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  // If no API keys are configured, return empty data instead of 401
  if (!isTmdbConfigured) {
    return emptyTmdbResponse<T>(path);
  }

  const url = getTmdbUrl(path, params);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };

  if (TMDB_READ_ACCESS_TOKEN) {
    headers['Authorization'] = `Bearer ${TMDB_READ_ACCESS_TOKEN}`;
  }

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= TMDB_MAX_RETRIES; attempt++) {
    // Timeout controller — prevents hanging requests (e.g. DNS failure)
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TMDB_TIMEOUT_MS);

    try {
      const response = await fetch(url, { headers, signal: controller.signal });
      clearTimeout(timer);

      if (!response.ok) {
        const status = response.status;
        // Non-retryable: throw immediately so caller gets the real status
        if (!TMDB_RETRYABLE.has(status)) {
          throw new TmdbError(status, `TMDB API error: ${status} ${response.statusText}`);
        }
        // Retryable: try again with backoff
        lastError = new TmdbError(status, `TMDB API error: ${status} ${response.statusText}`);
        if (attempt < TMDB_MAX_RETRIES) {
          const backoff = Math.min(1000 * 2 ** attempt, 4000); // 1s, 2s
          await sleep(backoff);
          continue;
        }
        throw lastError;
      }

      return response.json() as Promise<T>;
    } catch (err) {
      clearTimeout(timer);
      // AbortError from timeout — treat as retryable
      if (err instanceof DOMException && err.name === 'AbortError') {
        lastError = new TmdbError(0, 'TMDB request timed out');
        if (attempt < TMDB_MAX_RETRIES) {
          const backoff = Math.min(1000 * 2 ** attempt, 4000);
          await sleep(backoff);
          continue;
        }
        throw lastError;
      }
      // TmdbError (non-retryable) — re-throw as-is
      if (err instanceof TmdbError) throw err;
      // Unknown error (network) — retry
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < TMDB_MAX_RETRIES) {
        const backoff = Math.min(1000 * 2 ** attempt, 4000);
        await sleep(backoff);
        continue;
      }
      throw lastError;
    }
  }

  throw lastError || new Error('TMDB fetch failed');
}

export function getCorsHeaders() {
  // SECURITY: No CORS headers on content API routes.
  // These routes are called same-origin by the StreamVault SPA.
  // Same-origin requests never trigger CORS, so these headers are unnecessary.
  // Omitting them prevents cross-origin sites from reading our API responses.
  // Routes that need cross-origin access (proxy, embed) set their own headers.
  return {};
}

export function jsonResponse(data: unknown, status: number = 200, cacheControl?: string) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...getCorsHeaders(),
  };
  if (cacheControl) {
    headers['Cache-Control'] = cacheControl;
  }
  return new Response(JSON.stringify(data), { status, headers });
}

export function errorResponse(message: string, status: number = 500) {
  return jsonResponse({ error: message }, status);
}

/** Cache-Control presets for API routes */
export const CACHE = {
  /** Public content (trending, popular, genres, detail, search) */
  content: 'public, s-maxage=300, stale-while-revalidate=600',
  /** Very stable content (genres list — rarely changes) */
  stable: 'public, s-maxage=3600, stale-while-revalidate=86400',
  /** Per-user data (watchlist, users, sessions) — never cache */
  private: 'private, no-cache, no-store',
} as const;

export { TMDB_API_KEY, TMDB_READ_ACCESS_TOKEN, TMDB_BASE_URL, TMDB_IMAGE_BASE };
