import { NextRequest } from 'next/server';
import { tmdbFetch, getTmdbUrl, jsonResponse, errorResponse, getCorsHeaders, isTmdbConfigured, TMDB_READ_ACCESS_TOKEN, CACHE } from '@/lib/tmdb';
import { rateLimit, rateLimitResponse, getClientIp, RATE_LIMITS } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

/**
 * TMDB path allowlist — only paths actually used by the app are permitted.
 * Prevents abuse of the API key quota by blocking arbitrary TMDB endpoints
 * (e.g., /authentication/token/new, /account, /list/*, etc.).
 *
 * Pattern format: exact prefix match. Trailing slash is NOT allowed.
 * Dynamic segments are represented as placeholders (e.g., /movie/{id}).
 */
const ALLOWED_TMDB_PATH_PREFIXES = [
  '/trending',
  '/movie/popular',
  '/movie/top_rated',
  '/movie/now_playing',
  '/movie/upcoming',
  '/tv/popular',
  '/tv/top_rated',
  '/tv/on_the_air',
  '/tv/airing_today',
  '/genre/movie/list',
  '/genre/tv/list',
  '/discover/movie',
  '/discover/tv',
  '/search/movie',
  '/search/tv',
  '/search/multi',
  '/search/person',
  '/movie/',
  '/tv/',
  '/genre/',
  '/collection/',
] as const;

/** Validate that a TMDB path starts with an allowed prefix */
function isPathAllowed(path: string): boolean {
  // Normalize: strip leading slash, ensure single leading slash
  const normalized = '/' + path.replace(/^\/+/, '');
  return ALLOWED_TMDB_PATH_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export async function GET(request: NextRequest) {
  const ip = getClientIp(request);
  const rl = rateLimit(ip, RATE_LIMITS.content);
  if (!rl.allowed) return rateLimitResponse(rl, RATE_LIMITS.content);

  try {
    const searchParams = request.nextUrl.searchParams;
    const path = searchParams.get('path');

    if (!path) {
      return errorResponse('Missing required "path" query parameter', 400);
    }

    // SECURITY: Validate path against allowlist to prevent API key quota abuse
    if (!isPathAllowed(path)) {
      return errorResponse('Path not allowed', 403);
    }

    // Block path traversal attempts
    if (path.includes('..') || path.includes('//')) {
      return errorResponse('Invalid path', 400);
    }

    const page = searchParams.get('page') || '1';
    const language = searchParams.get('language') || 'en-US';

    // Build query params excluding 'path'
    const queryParams: Record<string, string> = { page, language };
    searchParams.forEach((value, key) => {
      if (!['path', 'page', 'language'].includes(key) && value) {
        queryParams[key] = value;
      }
    });

    // If TMDB keys not configured, return empty data
    if (!isTmdbConfigured) {
      return jsonResponse({ results: [], total_pages: 0, total_results: 0 }, 200, CACHE.content);
    }

    const url = getTmdbUrl(path, queryParams);
    const response = await fetch(url, {
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(TMDB_READ_ACCESS_TOKEN ? { Authorization: `Bearer ${TMDB_READ_ACCESS_TOKEN}` } : {}),
      },
      next: { revalidate: 300 },
    });

    if (!response.ok) {
      return errorResponse(
        `TMDB API error: ${response.status} ${response.statusText}`,
        response.status
      );
    }

    const data = await response.json();
    return jsonResponse(data, 200, CACHE.content);
  } catch (error) {
    console.error('[Stream API] Error:', error);
    return errorResponse(
      error instanceof Error ? error.message : 'Internal server error'
    );
  }
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: getCorsHeaders(),
  });
}
