import { NextRequest } from 'next/server';
import { tmdbFetch, jsonResponse, errorResponse, getCorsHeaders, CACHE } from '@/lib/tmdb';
import { rateLimit, rateLimitResponse, getClientIp, RATE_LIMITS } from '@/lib/rate-limit';
import type { ContentItem } from '@/types/streaming';

// No force-dynamic — let tmdbFetch's revalidate:300 cache upstream TMDB responses

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const ip = getClientIp(request);
  const rl = rateLimit(ip, RATE_LIMITS.content);
  if (!rl.allowed) return rateLimitResponse(rl, RATE_LIMITS.content);

  const { id } = await params;
  const searchParams = request.nextUrl.searchParams;
  const page = searchParams.get('page') || '1';
  const type = searchParams.get('type') || 'movie';

  const validTypes = ['movie', 'tv'];
  if (!validTypes.includes(type)) {
    return errorResponse(`Invalid type "${type}". Must be one of: ${validTypes.join(', ')}`, 400);
  }

  try {
    const data = await tmdbFetch<{ results: ContentItem[] }>(
      `/discover/${type}`,
      {
        with_genres: id,
        page,
        sort_by: 'popularity.desc',
      }
    );

    return jsonResponse(data, 200, CACHE.content);
  } catch (error) {
    console.error('[Genre Browse API] Error:', error);
    return errorResponse(
      error instanceof Error ? error.message : 'Failed to fetch genre content'
    );
  }
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: getCorsHeaders(),
  });
}
