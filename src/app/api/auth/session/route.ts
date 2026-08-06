import { createClient } from '@supabase/supabase-js';
import { NextRequest, NextResponse } from 'next/server';
import { CACHE } from '@/lib/tmdb';

const MAX_SESSIONS = 2;
// Sessions inactive for longer than this are considered stale and can be purged.
// 120 minutes (2 hours) accounts for:
//   - Mobile users backgrounding the app (browser throttles timers)
//   - iOS PWA being suspended by the OS for extended periods
//   - Momentary network interruptions
//   - User switching between apps for an extended time
// Old value was 30 min which caused false evictions for users who simply
// put their phone away for a while.
const STALE_THRESHOLD_MINUTES = 120;

/** Shared headers for per-user (private, no-cache) responses */
const PRIVATE = { headers: { 'Cache-Control': CACHE.private } };

// Verify a Supabase JWT and return the user ID.
async function verifyUser(jwt: string, supabaseUrl: string, supabaseAnonKey: string): Promise<string | null> {
  try {
    const client = createClient(supabaseUrl, supabaseAnonKey);
    const { data: { user } } = await client.auth.getUser(jwt);
    return user?.id ?? null;
  } catch {
    return null;
  }
}

export async function POST(request: NextRequest) {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  // 1. Authenticate via JWT
  const authHeader = request.headers.get('Authorization');
  const jwt = authHeader?.replace('Bearer ', '');
  if (!jwt) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const userId = await verifyUser(jwt, supabaseUrl, supabaseAnonKey);
  if (!userId) {
    return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 });
  }

  // 2. Parse body
  let body: { session_id?: string; device_info?: string; force?: boolean; heartbeat?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }

  const sessionId = body.session_id;
  if (!sessionId || typeof sessionId !== 'string' || sessionId.length < 10) {
    return NextResponse.json({ error: 'session_id required' }, { status: 400 });
  }

  const forceLogin = body.force === true;
  const isHeartbeat = body.heartbeat === true;
  const deviceInfo = typeof body.device_info === 'string' ? body.device_info.slice(0, 200) : '';
  const clientIp = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null;

  // 3. Connect to DB
  const db = supabaseServiceKey
    ? createClient(supabaseUrl, supabaseServiceKey)
    : createClient(supabaseUrl, supabaseAnonKey, {
        global: { headers: { Authorization: `Bearer ${jwt}` } },
      });

  // 4. Purge stale sessions (non-critical)
  try {
    const staleCutoff = new Date(Date.now() - STALE_THRESHOLD_MINUTES * 60 * 1000).toISOString();
    await db
      .from('user_sessions')
      .delete()
      .eq('user_id', userId)
      .lt('last_active', staleCutoff);
  } catch {
    // Non-critical
  }

  // 5. Fetch active sessions
  const { data: activeSessions, error: selectError } = await db
    .from('user_sessions')
    .select('id, session_id, last_active, device_info')
    .eq('user_id', userId);

  if (selectError) {
    // DB error — FAIL OPEN. Never lock users out.
    return NextResponse.json({ active: true, session_count: 0, tracked: false }, PRIVATE);
  }

  const sessions = activeSessions ?? [];
  const currentSession = sessions.find((s) => s.session_id === sessionId);

  // ── Existing session — heartbeat ─────────────────────────────
  if (currentSession && !forceLogin) {
    await db
      .from('user_sessions')
      .update({ last_active: new Date().toISOString(), device_info: deviceInfo })
      .eq('id', currentSession.id);
    return NextResponse.json({ active: true, session_count: sessions.length }, PRIVATE);
  }

  // ── Force login: wipe ALL sessions for this user, then insert new one
  if (forceLogin) {
    await db.from('user_sessions').delete().eq('user_id', userId);
    const { error: forceInsertError } = await db.from('user_sessions').insert({
      user_id: userId,
      session_id: sessionId,
      device_info: deviceInfo,
      ip_address: clientIp,
      last_active: new Date().toISOString(),
    });
    if (forceInsertError) {
      return NextResponse.json({ active: true, session_count: 0, tracked: false }, PRIVATE);
    }
    return NextResponse.json({ active: true, session_count: 1, forced: true }, PRIVATE);
  }

  // ── Heartbeat for evicted session — signal logout ──────────
  // When a device's session was wiped (force-login from another device)
  // but it's still sending heartbeats, do NOT re-insert. Return active:false
  // so the client triggers onEvicted() and signs out.
  if (isHeartbeat && !currentSession) {
    return NextResponse.json({ active: false, session_count: sessions.length, evicted: true }, PRIVATE);
  }

  // ── New session — check limit ───────────────────────────────
  if (sessions.length >= MAX_SESSIONS) {
    const deviceList = sessions
      .map((s) => s.device_info || 'Unknown device')
      .join(', ');

    return NextResponse.json(
      {
        active: false,
        session_count: sessions.length,
        rejected: true,
        reason: `You're signed in on ${sessions.length} devices (${deviceList}). Sign out from one of them to sign in here.`,
      },
      { status: 403 },
    );
  }

  // Room available — insert
  const { error: insertError } = await db.from('user_sessions').insert({
    user_id: userId,
    session_id: sessionId,
    device_info: deviceInfo,
    ip_address: clientIp,
    last_active: new Date().toISOString(),
  });

  if (insertError) {
    // INSERT failed — fail open
    return NextResponse.json({ active: true, session_count: sessions.length, tracked: false }, PRIVATE);
  }

  return NextResponse.json({ active: true, session_count: sessions.length + 1 }, PRIVATE);
}

// DELETE: remove a specific session (used on explicit logout)
export async function DELETE(request: NextRequest) {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  const authHeader = request.headers.get('Authorization');
  const jwt = authHeader?.replace('Bearer ', '');
  if (!jwt) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const userId = await verifyUser(jwt, supabaseUrl, supabaseAnonKey);
  if (!userId) {
    return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 });
  }

  let body: { session_id?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }

  if (!body.session_id) {
    return NextResponse.json({ error: 'session_id required' }, { status: 400 });
  }

  const db = supabaseServiceKey
    ? createClient(supabaseUrl, supabaseServiceKey)
    : createClient(supabaseUrl, supabaseAnonKey, {
        global: { headers: { Authorization: `Bearer ${jwt}` } },
      });

  await db
    .from('user_sessions')
    .delete()
    .eq('user_id', userId)
    .eq('session_id', body.session_id);

  return NextResponse.json({ success: true }, PRIVATE);
}
