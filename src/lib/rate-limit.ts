/**
 * In-memory sliding-window rate limiter for API routes.
 *
 * No external dependencies. Uses a Map with periodic cleanup
 * to prevent unbounded memory growth. Suitable for single-server
 * deployments (Vercel serverless, single Node.js instance).
 *
 * Each IP gets a sliding window of `windowMs` milliseconds.
 * Within that window, up to `maxRequests` are allowed.
 * Exceeding the limit returns a `RateLimitResponse` with
 * standard `Retry-After` and `X-RateLimit-*` headers.
 */

interface RateLimitEntry {
  timestamps: number[];
}

interface RateLimitConfig {
  /** Maximum requests per window per IP */
  maxRequests: number;
  /** Window duration in milliseconds */
  windowMs: number;
}

interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetMs: number;
}

const store = new Map<string, RateLimitEntry>();

/** Cleanup stale entries every 5 minutes */
const CLEANUP_INTERVAL = 5 * 60 * 1000;
let lastCleanup = 0;

function cleanup(now: number): void {
  if (now - lastCleanup < CLEANUP_INTERVAL) return;
  lastCleanup = now;

  for (const [key, entry] of store) {
    // Remove timestamps outside a 10-minute lookback (covers any reasonable window)
    const cutoff = now - 10 * 60 * 1000;
    entry.timestamps = entry.timestamps.filter((t) => t > cutoff);
    if (entry.timestamps.length === 0) {
      store.delete(key);
    }
  }
}

/**
 * Check if a request from the given IP is within rate limits.
 * Returns the result and updates internal state.
 */
export function rateLimit(
  ip: string,
  config: RateLimitConfig,
): RateLimitResult {
  const now = Date.now();
  cleanup(now);

  const entry = store.get(ip) ?? { timestamps: [] };
  const windowStart = now - config.windowMs;

  // Prune timestamps outside the current window
  entry.timestamps = entry.timestamps.filter((t) => t > windowStart);

  const allowed = entry.timestamps.length < config.maxRequests;

  if (allowed) {
    entry.timestamps.push(now);
  }

  store.set(ip, entry);

  // Calculate when the oldest timestamp in the window expires
  const oldest = entry.timestamps.length > 0 ? entry.timestamps[0] : now;
  const resetMs = Math.max(0, oldest + config.windowMs - now);

  return {
    allowed,
    remaining: Math.max(0, config.maxRequests - entry.timestamps.length),
    resetMs,
  };
}

/**
 * Create a Next.js Response for rate-limited requests (429).
 * Includes standard headers so clients can back off gracefully.
 */
export function rateLimitResponse(
  result: RateLimitResult,
  config: RateLimitConfig,
): Response {
  const retryAfterSeconds = Math.ceil(result.resetMs / 1000);

  return new Response(
    JSON.stringify({
      error: 'Too many requests',
      retryAfter: retryAfterSeconds,
    }),
    {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': String(retryAfterSeconds),
        'X-RateLimit-Limit': String(config.maxRequests),
        'X-RateLimit-Remaining': '0',
        'X-RateLimit-Reset': String(Math.ceil((Date.now() + result.resetMs) / 1000)),
      },
    },
  );
}

/**
 * Predefined rate limit configurations for different route categories.
 */
export const RATE_LIMITS = {
  /** Content browsing routes — generous (user navigates multiple pages) */
  content: { maxRequests: 120, windowMs: 60_000 } as RateLimitConfig,
  /** Search — slightly more restrictive to prevent abuse */
  search: { maxRequests: 60, windowMs: 60_000 } as RateLimitConfig,
  /** Stream source resolution — moderate */
  source: { maxRequests: 30, windowMs: 60_000 } as RateLimitConfig,
  /** Proxy (video segment fetching) — higher volume expected for downloads */
  proxy: { maxRequests: 300, windowMs: 60_000 } as RateLimitConfig,
  /** Embed proxy — moderate */
  embed: { maxRequests: 30, windowMs: 60_000 } as RateLimitConfig,
  /** Auth routes — strict to prevent brute force */
  auth: { maxRequests: 10, windowMs: 60_000 } as RateLimitConfig,
  /** Config endpoint — very strict (called once on mount) */
  config: { maxRequests: 20, windowMs: 60_000 } as RateLimitConfig,
  /** User data routes — moderate */
  user: { maxRequests: 30, windowMs: 60_000 } as RateLimitConfig,
  /** Watchlist — moderate */
  watchlist: { maxRequests: 30, windowMs: 60_000 } as RateLimitConfig,
} as const;

/**
 * Extract client IP from a Next.js request.
 * Checks X-Forwarded-For (set by Vercel/CDN), X-Real-IP, then falls back
 * to the connection remote address.
 */
export function getClientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0].trim();
    if (first) return first;
  }

  const realIp = request.headers.get('x-real-ip');
  if (realIp) return realIp.trim();

  return 'unknown';
}
