import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/types/supabase';
import { rateLimit, rateLimitResponse, getClientIp, RATE_LIMITS } from '@/lib/rate-limit';
import { CACHE } from '@/lib/tmdb';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || '';
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const supabaseAvailable = !!(supabaseUrl && supabaseAnonKey);

// Module-level client used ONLY for auth token verification.
const supabase = supabaseAvailable
  ? createClient<Database>(supabaseUrl, supabaseAnonKey)
  : null;

// Service-role client for admin queries — bypasses RLS entirely.
const supabaseAdmin = supabaseAvailable && supabaseServiceKey
  ? createClient<Database>(supabaseUrl, supabaseServiceKey)
  : null;

/** Shared headers for per-user (private, no-cache) responses */
const PRIVATE = { headers: { 'Cache-Control': CACHE.private } };

/**
 * Creates a Supabase client that runs data queries as the given user.
 * RLS policies for `authenticated` role apply.
 */
function createAuthedClient(token: string) {
  if (!supabaseAvailable) return null;
  return createClient<Database>(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}

function mapProfiles(
  profiles: Array<{
    id: string; email: string; display_name: string; avatar_url: string | null;
    role: string; created_at: string; updated_at: string;
  }>,
  partyMemberships: Map<string, { partyId: string; partyTitle: string | null; memberStatus: 'joined' | 'invited' }>,
) {
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  return profiles.map((p) => ({
    id: p.id,
    name: p.display_name || 'User',
    avatar_url: p.avatar_url,
    role: p.role,
    is_active: new Date(p.updated_at) > thirtyDaysAgo,
    member_since: p.created_at,
    party: partyMemberships.get(p.id) ?? null,
  }));
}

/**
 * GET /api/users
 * Returns all user profiles. Requires a valid auth token in the Authorization header.
 *
 * Admin uses service-role client (bypasses RLS) for guaranteed full visibility.
 * Non-admin uses service-role client if available, falls back to authed client (RLS applies).
 */
export async function GET(request: Request) {
  // Rate limit
  const ip = getClientIp(request);
  const rl = rateLimit(ip, RATE_LIMITS.user);
  if (!rl.allowed) return rateLimitResponse(rl, RATE_LIMITS.user);

  try {
    if (!supabaseAvailable || !supabase) {
      return NextResponse.json({ users: [] }, PRIVATE);
    }

    // Verify the caller is authenticated
    const authHeader = request.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const token = authHeader.replace('Bearer ', '');

    // Verify the token
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 });
    }

    // ── Fetch all profiles ──
    // Prefer service-role client (bypasses RLS for all users).
    // Fall back to authed client if service-role key is unavailable.
    const db = createAuthedClient(token);
    if (!db && !supabaseAdmin) {
      return NextResponse.json({ error: 'Database unavailable' }, { status: 503 });
    }
    const queryDb = supabaseAdmin ?? db;

    const { data: profiles, error } = await queryDb
      .from('profiles')
      .select('id, email, display_name, avatar_url, role, created_at, updated_at')
      .order('updated_at', { ascending: false });

    if (error) {
      return NextResponse.json({ users: [] }, PRIVATE);
    }

    // ── Fetch active watch party memberships ──
    // Maps user_id → { partyId, partyTitle } for users currently in an active party
    const partyMemberships = new Map<string, { partyId: string; partyTitle: string | null; memberStatus: 'joined' | 'invited' }>();

    try {
      // Get all non-ended parties
      const { data: activeParties } = await queryDb
        .from('watch_parties')
        .select('id, content_title')
        .neq('status', 'ended');

      if (activeParties && activeParties.length > 0) {
        const partyIds = activeParties.map((p) => p.id);
        const partyTitleMap = new Map(activeParties.map((p) => [p.id, p.content_title]));

        // Get active members (joined + invited) for those parties
        const { data: memberRows } = await queryDb
          .from('watch_party_members')
          .select('user_id, party_id, status')
          .in('party_id', partyIds)
          .in('status', ['joined', 'invited']);

        if (memberRows) {
          for (const row of memberRows) {
            // Don't overwrite 'joined' with 'invited' if user has multiple entries
            const existing = partyMemberships.get(row.user_id);
            if (!existing || existing.memberStatus === 'invited') {
              partyMemberships.set(row.user_id, {
                partyId: row.party_id,
                partyTitle: partyTitleMap.get(row.party_id) ?? null,
                memberStatus: row.status as 'joined' | 'invited',
              });
            }
          }
        }
      }
    } catch {
      // watch_party tables may not exist — non-critical, skip party data
    }

    return NextResponse.json({ users: mapProfiles(profiles ?? [], partyMemberships) }, PRIVATE);
  } catch {
    return NextResponse.json({ users: [] });
  }
}
