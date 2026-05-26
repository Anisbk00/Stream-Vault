import { NextRequest } from 'next/server';
import { jsonResponse, errorResponse, getCorsHeaders, CACHE } from '@/lib/tmdb';
import { rateLimit, rateLimitResponse, getClientIp, RATE_LIMITS } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

const CATALOG_BASE = 'https://vidapi.ru/episodes/latest';

/**
 * GET /api/stream/catalog/episodes?page=N
 *
 * Proxies vidapi.ru latest episodes catalog with pagination support.
 * Returns the upstream JSON response with CORS headers.
 */
export async function GET(request: NextRequest) {
  const ip = getClientIp(request);
  const rl = rateLimit(ip, RATE_LIMITS.content);
  if (!rl.allowed) return rateLimitResponse(rl, RATE_LIMITS.content);

  try {
    const page = request.nextUrl.searchParams.get('page') || '1';
    const pageNum = parseInt(page, 10);

    if (isNaN(pageNum) || pageNum < 1) {
      return errorResponse('Invalid page parameter. Must be a positive integer.', 400);
    }

    const url = `${CATALOG_BASE}/page-${pageNum}.json`;

    const upstream = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!upstream.ok) {
      console.error(
        `[Catalog Episodes] Upstream error: ${upstream.status} ${upstream.statusText}`,
      );
      return errorResponse(
        `Upstream catalog error: ${upstream.status}`,
        upstream.status === 404 ? 404 : 502,
      );
    }

    const data = await upstream.json();
    return jsonResponse(data, 200, CACHE.content);
  } catch (error) {
    console.error('[Catalog Episodes] Error:', error);
    return errorResponse(
      error instanceof Error ? error.message : 'Failed to fetch episode catalog',
    );
  }
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: getCorsHeaders(),
  });
}
