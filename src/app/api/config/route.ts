import { NextRequest, NextResponse } from 'next/server';
import { rateLimit, rateLimitResponse, getClientIp, RATE_LIMITS } from '@/lib/rate-limit';

/**
 * Returns the Supabase configuration from server-side environment variables.
 * This route ALWAYS reads from runtime env vars (not build-time inlined values),
 * so it works correctly on Vercel even after env var changes.
 *
 * The client fetches this on mount to ensure the Supabase client
 * is initialized with the correct credentials.
 *
 * SECURITY: TMDB API keys are NEVER exposed to the client.
 * They are used exclusively in server-side API routes via tmdbFetch().
 */
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  // Rate limit
  const ip = getClientIp(request);
  const result = rateLimit(ip, RATE_LIMITS.config);
  if (!result.allowed) {
    return rateLimitResponse(result, RATE_LIMITS.config);
  }

  const supabaseUrl =
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    process.env.SUPABASE_URL ||
    '';

  const supabaseAnonKey =
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    '';

  // Only confirm that TMDB is configured — never expose the actual keys.
  // The client doesn't need them; all TMDB calls go through backend routes.
  const tmdbConfigured = !!(
    process.env.TMDB_API_KEY || process.env.TMDB_READ_ACCESS_TOKEN
  );

  return NextResponse.json(
    {
      supabaseUrl,
      supabaseAnonKey,
      tmdbConfigured,
    },
    {
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
        'X-RateLimit-Remaining': String(result.remaining),
      },
    },
  );
}
