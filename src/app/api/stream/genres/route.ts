import { NextRequest } from 'next/server';
import { tmdbFetch, jsonResponse, errorResponse, getCorsHeaders, CACHE } from '@/lib/tmdb';
import { rateLimit, rateLimitResponse, getClientIp, RATE_LIMITS } from '@/lib/rate-limit';

// No force-dynamic — genres rarely change, cache aggressively

interface GenreListResponse {
  genres: { id: number; name: string }[];
}

export async function GET(request: NextRequest) {
  const ip = getClientIp(request);
  const rl = rateLimit(ip, RATE_LIMITS.content);
  if (!rl.allowed) return rateLimitResponse(rl, RATE_LIMITS.content);

  try {
    const searchParams = request.nextUrl.searchParams;
    const type = searchParams.get('type') || 'movie';

    const validTypes = ['movie', 'tv'];
    if (!validTypes.includes(type)) {
      return errorResponse(`Invalid type "${type}". Must be one of: ${validTypes.join(', ')}`, 400);
    }

    const data = await tmdbFetch<GenreListResponse>(
      `/genre/${type}/list`
    );

    return jsonResponse(data, 200, CACHE.stable);
  } catch (err) {
    // Graceful degradation — genres are non-critical.
    // Return empty list (200) instead of 404 to avoid console errors on every browse.
    return jsonResponse({ genres: [] });
  }
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: getCorsHeaders(),
  });
}
