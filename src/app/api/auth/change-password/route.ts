import { NextRequest, NextResponse } from 'next/server';
import { rateLimit, rateLimitResponse, getClientIp, RATE_LIMITS } from '@/lib/rate-limit';
import { CACHE } from '@/lib/tmdb';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || '';
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '';

export async function POST(request: NextRequest) {
  // Rate limit — strict for auth endpoints to prevent brute force
  const ip = getClientIp(request);
  const rl = rateLimit(ip, RATE_LIMITS.auth);
  if (!rl.allowed) return rateLimitResponse(rl, RATE_LIMITS.auth);

  try {
    if (!supabaseUrl || !supabaseAnonKey) {
      return NextResponse.json(
        { error: 'Authentication is not configured' },
        { status: 503 },
      );
    }

    // ── Step 1: Verify caller identity via Authorization header JWT ──
    // SECURITY: Use the JWT from the Authorization header (server-side reliable).
    // Previous implementation used getSession() which reads from localStorage
    // — not available in server-side Route Handlers. This ensures the endpoint
    // correctly identifies the user regardless of transport.
    const authHeader = request.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 },
      );
    }

    const token = authHeader.replace('Bearer ', '');

    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(supabaseUrl, supabaseAnonKey);

    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return NextResponse.json(
        { error: 'Invalid or expired token' },
        { status: 401 },
      );
    }

    const userEmail = user.email;
    if (!userEmail) {
      return NextResponse.json(
        { error: 'User has no email — cannot verify current password' },
        { status: 401 },
      );
    }

    // ── Step 2: Parse and validate request body ──
    const { newPassword, currentPassword } = await request.json();

    if (!newPassword || typeof newPassword !== 'string') {
      return NextResponse.json(
        { error: 'New password is required' },
        { status: 400 },
      );
    }

    if (!currentPassword || typeof currentPassword !== 'string') {
      return NextResponse.json(
        { error: 'Current password is required' },
        { status: 400 },
      );
    }

    // Password policy: minimum 8 characters, at least one letter and one digit
    if (newPassword.length < 8) {
      return NextResponse.json(
        { error: 'Password must be at least 8 characters' },
        { status: 400 },
      );
    }

    if (!/[a-zA-Z]/.test(newPassword)) {
      return NextResponse.json(
        { error: 'Password must contain at least one letter' },
        { status: 400 },
      );
    }

    if (!/\d/.test(newPassword)) {
      return NextResponse.json(
        { error: 'Password must contain at least one number' },
        { status: 400 },
      );
    }

    // ── Step 3: Verify current password before allowing change ──
    // SECURITY: Re-authenticate with email + current password.
    // This prevents session hijacking from escalating to full account takeover.
    // Even if an attacker has a valid JWT, they must also know the current password.
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email: userEmail,
      password: currentPassword,
    });

    if (signInError) {
      return NextResponse.json(
        { error: 'Current password is incorrect' },
        { status: 403 },
      );
    }

    // ── Step 4: Update password ──
    const { data, error } = await supabase.auth.updateUser({
      password: newPassword,
    });

    if (error) {
      return NextResponse.json(
        { error: error.message },
        { status: 400 },
      );
    }

    return NextResponse.json({ success: true, user: data.user }, { headers: { 'Cache-Control': CACHE.private } });
  } catch {
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}
