import { NextRequest } from 'next/server';
import { tmdbFetch, jsonResponse, errorResponse, getCorsHeaders, TmdbError, CACHE } from '@/lib/tmdb';
import { rateLimit, rateLimitResponse, getClientIp, RATE_LIMITS } from '@/lib/rate-limit';
import type { ContentItem } from '@/types/streaming';

// No force-dynamic — let tmdbFetch's revalidate:300 cache upstream TMDB responses

interface TmdbPagedResponse<T> {
  results: T[];
  total_results: number;
  total_pages: number;
  page: number;
}

/**
 * Search API with optional filters.
 *
 * Query params:
 *  - q: search query (required)
 *  - page: page number (default 1)
 *  - type: 'all' | 'movie' | 'tv' (default 'all')
 *  - year: release/air year (e.g. 2024) — maps to primary_release_year (movie) / first_air_date_year (tv)
 *  - genre: TMDB genre ID (comma-separated for multiple, e.g. "28,12")
 *  - sort: 'popularity' | 'rating' | 'newest' | 'oldest' (default 'popularity')
 *  - min_rating: minimum vote_average (0-10)
 *
 * Three-tier strategy (prioritizes RELEVANCE over popularity for exact matching):
 *
 *  Tier 1 — No filters, type=all:
 *    /search/multi → relevance-ordered, but returns people/companies too.
 *    Filter out person results + boost exact title matches client-side.
 *
 *  Tier 2 — type=movie or type=tv, no year/genre/rating/sort filters:
 *    /search/movie or /search/tv → purpose-built for text search,
 *    relevance-ordered, NO person clutter. Best for "find this exact title".
 *
 *  Tier 3 — year/genre/rating/sort filters active (requires /discover):
 *    /discover/{type}?with_text_query=X → supports all filters,
 *    but sorts by sort_by (popularity/date), NOT relevance.
 *    Only used when the user explicitly wants to filter, not for plain search.
 */
export async function GET(request: NextRequest) {
  const ip = getClientIp(request);
  const rl = rateLimit(ip, RATE_LIMITS.search);
  if (!rl.allowed) return rateLimitResponse(rl, RATE_LIMITS.search);

  const searchParams = request.nextUrl.searchParams;
  const query = searchParams.get('q');

  if (!query || query.trim() === '') {
    return errorResponse('Missing required "q" query parameter', 400);
  }

  const trimmedQuery = query.trim();
  const page = searchParams.get('page') || '1';
  const type = (searchParams.get('type') || 'all') as 'all' | 'movie' | 'tv';
  const year = searchParams.get('year') || '';
  const genre = searchParams.get('genre') || '';
  const sort = (searchParams.get('sort') || 'popularity') as 'popularity' | 'rating' | 'newest' | 'oldest';
  const minRating = searchParams.get('min_rating') || '';

  // Only year/genre/rating/sort require /discover. Type alone does NOT —
  // /search/movie and /search/tv are better for type-filtered text search.
  const hasDiscoverFilters = !!year || !!genre || !!minRating || (sort !== 'popularity');

  try {
    // ── Tier 1: no filters, type=all → /search/multi ──
    if (type === 'all' && !hasDiscoverFilters) {
      const data = await tmdbFetch<TmdbPagedResponse<ContentItem>>(
        '/search/multi',
        { query: trimmedQuery, page, include_adult: 'false', language: 'en-US' },
      );
      // Filter out person/company/collection results — useless for a streaming app
      const filtered = data.results.filter(
        (item) => item.media_type !== 'person' && item.media_type !== 'company' && item.media_type !== 'collection',
      );
      // Boost exact title matches to the top (TMDB relevance is good but not perfect)
      boostExactMatches(filtered, trimmedQuery);

      return jsonResponse(
        { results: filtered, total_results: filtered.length, total_pages: data.total_pages, page: Number(page) },
        200,
        CACHE.content,
      );
    }

    // ── Tier 2: type=movie or type=tv, no discover filters → /search/{type} ──
    if (!hasDiscoverFilters) {
      const endpoint = type === 'tv' ? '/search/tv' : '/search/movie';
      const data = await tmdbFetch<TmdbPagedResponse<ContentItem>>(
        endpoint,
        { query: trimmedQuery, page, include_adult: 'false', language: 'en-US' },
      );
      // Tag media_type (search/movie and search/tv don't set it)
      const tagged = data.results.map((item) => ({ ...item, media_type: type }));
      // Boost exact title matches
      boostExactMatches(tagged, trimmedQuery);

      return jsonResponse(
        { results: tagged, total_results: data.total_results, total_pages: data.total_pages, page: Number(page) },
        200,
        CACHE.content,
      );
    }

    // ── Tier 3: year/genre/rating/sort filters active → /discover/{type} ──
    const sortBy = mapSortParam(sort, type === 'tv');

    const fetches: Promise<TmdbPagedResponse<ContentItem>>[] = [];
    const typesToFetch: ('movie' | 'tv')[] = type === 'all' ? ['movie', 'tv'] : [type];

    for (const t of typesToFetch) {
      const params: Record<string, string> = {
        query: trimmedQuery,
        page,
        include_adult: 'false',
        sort_by: sortBy,
        'vote_count.gte': '50', // filter out obscure low-vote results when filtering
        language: 'en-US',
      };
      if (year) {
        if (t === 'movie') params['primary_release_year'] = year;
        else params['first_air_date_year'] = year;
      }
      if (genre) params['with_genres'] = genre;
      if (minRating) params['vote_average.gte'] = minRating;

      fetches.push(tmdbFetch<TmdbPagedResponse<ContentItem>>(`/discover/${t}`, params));
    }

    const responses = await Promise.allSettled(fetches);

    // Merge results from movie + tv discover
    const merged: ContentItem[] = [];
    let totalPages = 0;
    let totalResults = 0;

    responses.forEach((res, i) => {
      if (res.status === 'fulfilled') {
        const t = typesToFetch[i];
        // Tag each item with media_type so the UI can distinguish movie vs tv
        for (const item of res.value.results) {
          merged.push({ ...item, media_type: item.media_type || t });
        }
        totalResults += res.value.total_results || 0;
        totalPages = Math.max(totalPages, res.value.total_pages || 0);
      }
    });

    // When merging movie + tv, sort the combined list by the chosen sort
    // (each discover call returns its own sorted list, but the merge breaks order)
    sortMergedResults(merged, sort);

    return jsonResponse(
      { results: merged, total_results: totalResults, total_pages: totalPages, page: Number(page) },
      200,
      CACHE.content,
    );
  } catch (error) {
    if (error instanceof TmdbError) {
      const status = error.status === 0 ? 504 : 502;
      return errorResponse('Service temporarily unavailable — try again', status);
    }
    return errorResponse('Service temporarily unavailable — try again', 502);
  }
}

/**
 * Boost exact and prefix title matches to the top of the results.
 * TMDB relevance ordering is good but sometimes puts partial matches first.
 *
 * Priority:
 *  1. Exact match (title/name === query, case-insensitive)
 *  2. Prefix match (title/name starts with query)
 *  3. Contains match (query is a substring)
 *  4. Everything else (keeps TMDB's relevance order)
 *
 * Mutates the array in-place. Stable within each priority bucket.
 */
function boostExactMatches(items: ContentItem[], query: string): void {
  const q = query.toLowerCase();
  items.sort((a, b) => {
    const titleA = (getDisplayTitle(a)).toLowerCase();
    const titleB = (getDisplayTitle(b)).toLowerCase();
    const rankA = matchRank(titleA, q);
    const rankB = matchRank(titleB, q);
    return rankA - rankB; // lower rank = higher priority
  });
}

function matchRank(title: string, query: string): number {
  if (title === query) return 0;          // exact match
  if (title.startsWith(query)) return 1;  // prefix match
  if (title.includes(query)) return 2;    // contains match
  return 3;                                // no direct title match
}

function getDisplayTitle(item: ContentItem): string {
  return item.title || item.name || item.original_title || item.original_name || '';
}

/** Map UI sort param to TMDB sort_by value */
function mapSortParam(sort: string, isTv: boolean): string {
  switch (sort) {
    case 'rating':
      return 'vote_average.desc';
    case 'newest':
      return isTv ? 'first_air_date.desc' : 'primary_release_date.desc';
    case 'oldest':
      return isTv ? 'first_air_date.asc' : 'primary_release_date.asc';
    case 'popularity':
    default:
      return 'popularity.desc';
  }
}

/** Sort merged results client-side (movie + tv lists each come pre-sorted) */
function sortMergedResults(items: ContentItem[], sort: string): void {
  switch (sort) {
    case 'rating':
      items.sort((a, b) => (b.vote_average ?? 0) - (a.vote_average ?? 0));
      break;
    case 'newest': {
      items.sort((a, b) => {
        const da = new Date(a.release_date || a.first_air_date || 0).getTime();
        const db = new Date(b.release_date || b.first_air_date || 0).getTime();
        return db - da;
      });
      break;
    }
    case 'oldest': {
      items.sort((a, b) => {
        const da = new Date(a.release_date || a.first_air_date || 0).getTime();
        const db = new Date(b.release_date || b.first_air_date || 0).getTime();
        return da - db;
      });
      break;
    }
    case 'popularity':
    default:
      items.sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0));
      break;
  }
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: getCorsHeaders(),
  });
}
