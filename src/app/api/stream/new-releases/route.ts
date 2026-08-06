import { NextRequest } from 'next/server';
import { tmdbFetch, jsonResponse, errorResponse, getCorsHeaders, CACHE } from '@/lib/tmdb';
import { rateLimit, rateLimitResponse, getClientIp, RATE_LIMITS } from '@/lib/rate-limit';
import type { ContentItem } from '@/types/streaming';

// No force-dynamic — let tmdbFetch's revalidate:300 cache upstream TMDB responses

interface CombinedReleasesResponse {
  results: ContentItem[];
}

export async function GET(request: NextRequest) {
  const ip = getClientIp(request);
  const rl = rateLimit(ip, RATE_LIMITS.content);
  if (!rl.allowed) return rateLimitResponse(rl, RATE_LIMITS.content);

  try {
    // Use allSettled — partial failure returns available data instead of failing entirely
    const [moviesResult, tvResult] = await Promise.allSettled([
      tmdbFetch<{ results: ContentItem[] }>('/movie/now_playing', { page: '1' }),
      tmdbFetch<{ results: ContentItem[] }>('/tv/on_the_air', { page: '1' }),
    ]);

    const movieResults = (moviesResult.status === 'fulfilled' ? moviesResult.value.results || [] : [])
      .map((item) => ({ ...item, media_type: 'movie' as const }));

    const tvResults = (tvResult.status === 'fulfilled' ? tvResult.value.results || [] : [])
      .map((item) => ({ ...item, media_type: 'tv' as const }));

    const merged: ContentItem[] = [
      ...movieResults,
      ...tvResults,
    ].sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0));

    const response: CombinedReleasesResponse = { results: merged };

    return jsonResponse(response, 200, CACHE.content);
  } catch (error) {
    return errorResponse(
      error instanceof Error ? error.message : 'Failed to fetch new releases'
    );
  }
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: getCorsHeaders(),
  });
}
