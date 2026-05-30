import { NextRequest } from 'next/server';
import { tmdbFetch, jsonResponse, errorResponse, getCorsHeaders, TmdbError, CACHE } from '@/lib/tmdb';
import { rateLimit, rateLimitResponse, getClientIp, RATE_LIMITS } from '@/lib/rate-limit';
import type { ContentItem } from '@/types/streaming';

// No force-dynamic — let tmdbFetch's revalidate:300 cache upstream TMDB responses

export async function GET(request: NextRequest) {
  const ip = getClientIp(request);
  const rl = rateLimit(ip, RATE_LIMITS.search);
  if (!rl.allowed) return rateLimitResponse(rl, RATE_LIMITS.search);

  const searchParams = request.nextUrl.searchParams;
  const query = searchParams.get('q');

  if (!query || query.trim() === '') {
    return errorResponse('Missing required "q" query parameter', 400);
  }

  const page = searchParams.get('page') || '1';

  try {
    const data = await tmdbFetch<{ results: ContentItem[]; total_results: number; total_pages: number }>(
      '/search/multi',
      { query: query.trim(), page }
    );

    return jsonResponse(data, 200, CACHE.content);
  } catch (error) {
    if (error instanceof TmdbError) {
      const status = error.status === 0 ? 504 : 502;
      return errorResponse('Service temporarily unavailable — try again', status);
    }
    return errorResponse('Service temporarily unavailable — try again', 502);
  }
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: getCorsHeaders(),
  });
}
