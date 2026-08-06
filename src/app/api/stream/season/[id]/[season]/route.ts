import { NextRequest } from 'next/server';
import { tmdbFetch, jsonResponse, errorResponse, getCorsHeaders, TmdbError, CACHE } from '@/lib/tmdb';
import { rateLimit, rateLimitResponse, getClientIp, RATE_LIMITS } from '@/lib/rate-limit';
import type { EpisodeDetail } from '@/types/streaming';

// No force-dynamic — let tmdbFetch's revalidate:300 cache upstream TMDB responses

interface SeasonResponse {
  id: number;
  name: string;
  season_number: number;
  episodes: EpisodeDetail[];
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; season: string }> }
) {
  const ip = getClientIp(request);
  const rl = rateLimit(ip, RATE_LIMITS.content);
  if (!rl.allowed) return rateLimitResponse(rl, RATE_LIMITS.content);

  const { id, season } = await params;

  try {
    const data = await tmdbFetch<SeasonResponse>(
      `/tv/${id}/season/${season}`
    );

    return jsonResponse(data, 200, CACHE.content);
  } catch (error) {
    if (error instanceof TmdbError) {
      const status = error.status === 0 ? 504 : (error.status === 404 ? 404 : 502);
      const message = error.status === 404
        ? 'Season not found'
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
