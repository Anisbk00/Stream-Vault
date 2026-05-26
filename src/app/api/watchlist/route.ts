import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/types/supabase';
import { rateLimit, rateLimitResponse, getClientIp, RATE_LIMITS } from '@/lib/rate-limit';
import { CACHE } from '@/lib/tmdb';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || '';
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '';

const supabaseAvailable = !!(supabaseUrl && supabaseAnonKey);

/** Shared headers for per-user (private, no-cache) responses */
const PRIVATE = { headers: { 'Cache-Control': CACHE.private } };

// Module-level client used ONLY for auth token verification.
// Data queries MUST use a client with the caller's JWT so that RLS
// policies for the `authenticated` role apply correctly.
const supabase = supabaseAvailable
  ? createClient<Database>(supabaseUrl, supabaseAnonKey)
  : null;

/**
 * Creates a Supabase client that runs data queries as the given user.
 * This ensures RLS policies for `authenticated` role are enforced with
 * the correct `auth.uid()` context.
 */
function createAuthedClient(token: string) {
  if (!supabaseAvailable) return null;
  return createClient<Database>(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}

/**
 * GET /api/watchlist
 * Returns all watchlist items for the authenticated user.
 */
export async function GET(request: Request) {
  // Rate limit
  const ip = getClientIp(request);
  const rl = rateLimit(ip, RATE_LIMITS.watchlist);
  if (!rl.allowed) return rateLimitResponse(rl, RATE_LIMITS.watchlist);

  try {
    if (!supabaseAvailable || !supabase) {
      return NextResponse.json({ items: [] }, PRIVATE);
    }

    const authHeader = request.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 });
    }

    // Use caller's JWT so RLS policies apply correctly
    const db = createAuthedClient(token);
    if (!db) {
      return NextResponse.json({ items: [] }, PRIVATE);
    }

    const { data, error } = await db
      .from('watchlist')
      .select('content_id, media_type, item_data')
      .eq('user_id', user.id)
      .order('added_at', { ascending: false });

    if (error) {
      // Table missing or RLS blocks — return empty (local is fallback)
      return NextResponse.json({ items: [] }, PRIVATE);
    }

    const items = (data ?? []).map((row) => row.item_data as Record<string, unknown>);
    return NextResponse.json({ items }, PRIVATE);
  } catch {
    return NextResponse.json({ items: [] });
  }
}

/**
 * PUT /api/watchlist
 * Replaces the entire watchlist for the authenticated user.
 * Body: { items: ContentItem[] }
 */
export async function PUT(request: Request) {
  // Rate limit
  const ip = getClientIp(request);
  const rl = rateLimit(ip, RATE_LIMITS.watchlist);
  if (!rl.allowed) return rateLimitResponse(rl, RATE_LIMITS.watchlist);

  try {
    if (!supabaseAvailable || !supabase) {
      return NextResponse.json({ ok: true, syncSkipped: true }, PRIVATE);
    }

    const authHeader = request.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 });
    }

    const body = await request.json() as { items: Record<string, unknown>[] };
    const items = body.items ?? [];

    // Use caller's JWT so RLS policies apply correctly
    const db = createAuthedClient(token);
    if (!db) {
      return NextResponse.json({ ok: true, syncSkipped: true }, PRIVATE);
    }

    // Delete all existing items for this user, then insert new ones
    const { error: deleteError } = await db
      .from('watchlist')
      .delete()
      .eq('user_id', user.id);

    if (deleteError) {
      // Table missing or RLS blocks — silently succeed (local is fallback)
      const code = (deleteError as { code?: string }).code ?? '';
      if (code === '42P01' || code === '42501') {
        return NextResponse.json({ ok: true, tableMissing: true }, PRIVATE);
      }
      return NextResponse.json({ ok: true, syncSkipped: true }, PRIVATE);
    }

    if (items.length === 0) {
      return NextResponse.json({ ok: true }, PRIVATE);
    }

    const rows = items.map((item) => ({
      user_id: user.id,
      content_id: String(item.id ?? ''),
      media_type: String(item.media_type ?? 'movie'),
      item_data: item,
    }));

    const { error: insertError } = await db
      .from('watchlist')
      .insert(rows);

    if (insertError) {
      // Don't fail — local state is the fallback
      return NextResponse.json({ ok: true, syncSkipped: true }, PRIVATE);
    }

    return NextResponse.json({ ok: true }, PRIVATE);
  } catch {
    // Never throw — watchlist sync is fire-and-forget
    return NextResponse.json({ ok: true, syncSkipped: true });
  }
}

/**
 * DELETE /api/watchlist?content_id=xxx
 * Removes a single item from the watchlist.
 */
export async function DELETE(request: Request) {
  // Rate limit
  const ip = getClientIp(request);
  const rl = rateLimit(ip, RATE_LIMITS.watchlist);
  if (!rl.allowed) return rateLimitResponse(rl, RATE_LIMITS.watchlist);

  try {
    if (!supabaseAvailable || !supabase) {
      return NextResponse.json({ ok: true }, PRIVATE);
    }

    const authHeader = request.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 });
    }

    // Use caller's JWT so RLS policies apply correctly
    const db = createAuthedClient(token);
    if (!db) {
      return NextResponse.json({ ok: true }, PRIVATE);
    }

    const { searchParams } = new URL(request.url);
    const contentId = searchParams.get('content_id');
    if (!contentId) {
      return NextResponse.json({ error: 'content_id required' }, { status: 400 });
    }

    const { error } = await db
      .from('watchlist')
      .delete()
      .eq('user_id', user.id)
      .eq('content_id', contentId);

    if (error) {
      // Silently succeed — local state is the fallback
      return NextResponse.json({ ok: true }, PRIVATE);
    }

    return NextResponse.json({ ok: true }, PRIVATE);
  } catch {
    return NextResponse.json({ ok: true });
  }
}
