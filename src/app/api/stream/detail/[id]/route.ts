import { NextRequest } from 'next/server';
import { tmdbFetch, jsonResponse, errorResponse, getCorsHeaders, TmdbError, CACHE } from '@/lib/tmdb';
import { rateLimit, rateLimitResponse, getClientIp, RATE_LIMITS } from '@/lib/rate-limit';
import type { ContentDetail } from '@/types/streaming';

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
  const type = searchParams.get('type') || 'movie';

  const validTypes = ['movie', 'tv'];
  if (!validTypes.includes(type)) {
    return errorResponse(`Invalid type "${type}". Must be one of: ${validTypes.join(', ')}`, 400);
  }

  try {
    const data = await tmdbFetch<ContentDetail>(
      `/${type}/${id}`,
      {
        append_to_response: 'credits,similar,videos',
      }
    );

    return jsonResponse(data, 200, CACHE.content);
  } catch (error) {
    // Pass through the actual TMDB status code:
    // - 404: content genuinely doesn't exist
    // - 429/5xx: TMDB rate limit or server error (already retried)
    // - 0: request timed out
    if (error instanceof TmdbError) {
      const status = error.status === 0 ? 504 : (error.status === 404 ? 404 : 502);
      const message = error.status === 404
        ? 'Content not found'
        : 'Service temporarily unavailable — try again';
      return errorResponse(message, status);
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
