import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/supabase';

// ── Config resolution ───────────────────────────────────
// Priority order:
//  1. Explicit init (from Server Component props — always correct)
//  2. window.__SV_CONFIG__ (layout injection / api/config fallback)
//  3. Build-time env vars (only for local dev)

let _explicitUrl: string | null = null;
let _explicitKey: string | null = null;

/**
 * Initialize the Supabase client with explicit credentials.
 * Called once from MoveraApp with props from the Server Component.
 * This is the ONLY reliable source of truth on Vercel — all other
 * methods (build-time env vars, layout injection) can be stale.
 */
export function initSupabase(url: string, key: string): void {
  // Only reset the singleton if the credentials actually changed.
  // Unnecessary resets destroy the in-flight onAuthStateChange subscription
  // and can cause race conditions with getSession()/refreshToken.
  if (_explicitUrl === url && _explicitKey === key && _client) return;
  _explicitUrl = url;
  _explicitKey = key;
  _client = null;
}

/**
 * Resolve Supabase config using the same 3-tier priority as the singleton.
 * Exported so LoginScreen can create a fresh client with correct config
 * (bypassing the singleton to avoid GoTrue re-init hang) while still
 * resolving credentials from window.__SV_CONFIG__ or explicit init —
 * NOT from build-time process.env (which is empty/stale in cached PWA).
 */
export function getSupabaseConfig(): { url: string; key: string } {
  return resolveConfig();
}

function resolveConfig(): { url: string; key: string } {
  // 1. Explicit init from Server Component props (most reliable)
  if (_explicitUrl && _explicitKey) {
    return { url: _explicitUrl, key: _explicitKey };
  }

  // 2. window.__SV_CONFIG__ (from layout.tsx or /api/config)
  if (typeof window !== 'undefined') {
    const cfg = (window as unknown as { __SV_CONFIG__?: { supabaseUrl: string; supabaseAnonKey: string } }).__SV_CONFIG__;
    if (cfg?.supabaseUrl && cfg?.supabaseAnonKey) {
      return { url: cfg.supabaseUrl, key: cfg.supabaseAnonKey };
    }
  }

  // 3. Build-time env vars (local dev only)
  return {
    url: process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || '',
    key: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '',
  };
}

function createSupabaseClient(): SupabaseClient<Database> {
  const { url, key } = resolveConfig();
  if (!url || !key) {
    throw new Error(
      'Missing Supabase environment variables. ' +
      'Check .env locally and Vercel Environment Variables for deployment.'
    );
  }
  return createClient<Database>(url, key, {
    auth: {
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
      storageKey: 'movera-auth-token',
      storage: typeof window !== 'undefined'
        ? window.localStorage
        : undefined,
    },
  });
}

// Lazy singleton — resolves config on first access, not at import time.
// This is the ONLY SupabaseClient created on the client side.
// Every createClient() call spawns a GoTrueClient. GoTrueClient v2.106+
// tracks all instances globally and warns when >1 exist, producing
// undefined behavior (token refresh races, conflicting storage writes,
// session state corruption). One client = one GoTrueClient = no warning.
let _client: SupabaseClient<Database> | null = null;
function getSupabase(): SupabaseClient<Database> {
  if (!_client) _client = createSupabaseClient();
  return _client;
}

/** Reset the singleton so the next access re-creates the client with fresh config. */
export function resetSupabaseClient(): void {
  _client = null;
}

/**
 * Attempt to refresh the Supabase session.
 * Called when the JWT is expired but a refresh_token may still be valid
 * (e.g., PWA waking from long background/sleep).
 *
 * Returns the refreshed session on success, or null on failure.
 * On failure, the caller should transition to unauthenticated gracefully.
 */
export async function refreshSession(): Promise<{
  session: Awaited<ReturnType<SupabaseClient<Database>['auth']['getSession']>['data']['session']>;
  error: string | null;
}> {
  try {
    const { data, error } = await supabase.auth.refreshSession();
    if (error) {
      console.warn('[AUTH] refreshSession failed:', error.message);
      return { session: null, error: error.message };
    }
    console.warn('[AUTH] refreshSession succeeded, new expiry:', data.session?.expires_at);
    return { session: data.session, error: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown refresh error';
    console.warn('[AUTH] refreshSession exception:', msg);
    return { session: null, error: msg };
  }
}

/**
 * Validate whether the current session's access_token is expired.
 * Decodes the JWT payload without verification (client-side check only).
 * Returns true if the token is expired or cannot be decoded.
 */
export function isSessionTokenExpired(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    const raw = localStorage.getItem('movera-auth-token');
    if (!raw) return true;
    const session = JSON.parse(raw);
    const token = session?.access_token;
    if (!token || typeof token !== 'string') return true;
    const payloadB64 = token.split('.')[1];
    if (!payloadB64) return true;
    const payload = JSON.parse(atob(payloadB64));
    return Date.now() >= payload.exp * 1000;
  } catch {
    return true;
  }
}

// For compatibility: export as named export that behaves like the old singleton
export const supabase = new Proxy({} as SupabaseClient<Database>, {
  get(_target, prop) {
    return (getSupabase() as unknown as Record<string | symbol, unknown>)[prop];
  },
});

// ── Type-safe DB helpers ─────────────────────────────────

export type ProfileRow = {
  id: string;
  email: string;
  display_name: string;
  avatar_url: string | null;
  role: 'vip' | 'admin';
  created_at: string;
  updated_at: string;
};

export type ProfileRowWithComplete = ProfileRow & {
  is_complete: boolean;
};

/**
 * Fetch the current authenticated user's profile.
 * Returns null if not authenticated or profile not found.
 *
 * Uses the singleton client which auto-attaches the session token.
 * Filters by user ID to avoid `.single()` failure when multiple profiles exist.
 */
export async function getMyProfile(): Promise<ProfileRowWithComplete | null> {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token || !session.user?.id) return null;

    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', session.user.id)
      .maybeSingle();

    if (error || !data) return null;

    return {
      ...data,
      is_complete: data.display_name.trim().length > 0,
    };
  } catch {
    return null;
  }
}

/**
 * Update the current user's profile fields.
 * Only the fields provided in `updates` will be changed.
 * Uses the singleton client which auto-attaches the session token.
 */
export async function updateMyProfile(
  userId: string,
  updates: { display_name?: string; avatar_url?: string | null },
): Promise<ProfileRow | null> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) return null;

  const { data, error } = await supabase
    .from('profiles')
    .update(updates)
    .eq('id', userId)
    .select()
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data ?? null;
}

/**
 * Upsert (insert or update) the current user's profile.
 * Used during profile completion when the row may not exist yet.
 * Uses the singleton client which auto-attaches the session token.
 */
export async function upsertMyProfile(
  userId: string,
  row: { id: string; email: string; display_name: string; avatar_url?: string; role?: string },
): Promise<ProfileRow | null> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) return null;

  const { data, error } = await supabase
    .from('profiles')
    .upsert(row, { onConflict: 'id' })
    .select()
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data ?? null;
}

/**
 * Bump the current user's `updated_at` timestamp to signal activity.
 * Throttled: only writes if the last update was > 1 hour ago.
 * Uses the singleton client which auto-attaches the session token.
 */
export async function touchProfile(cachedUpdatedAt?: string): Promise<void> {
  try {
    // Throttle: skip if last update was within the last hour
    if (cachedUpdatedAt) {
      const lastUpdate = new Date(cachedUpdatedAt).getTime();
      if (Date.now() - lastUpdate < 60 * 60 * 1000) return;
    }

    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token || !session.user?.id) return;

    await supabase
      .from('profiles')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', session.user.id);
  } catch {
    // Silent — activity heartbeat should never block the UI
  }
}

/**
 * Upload an avatar image to Supabase Storage.
 * File is stored at: avatars/{userId}/{timestamp}.{ext}
 * Returns the public URL, or null on failure.
 */
export async function uploadAvatar(
  userId: string,
  file: File,
): Promise<string | null> {
  const ext = file.name.split('.').pop() || 'jpg';
  const filePath = `${userId}/${Date.now()}.${ext}`;

  const { error } = await supabase.storage
    .from('avatars')
    .upload(filePath, file, {
      cacheControl: '31536000', // 1 year
      upsert: true,
    });

  if (error) return null;

  const { data: urlData } = supabase.storage
    .from('avatars')
    .getPublicUrl(filePath);

  return urlData.publicUrl;
}

/**
 * Delete the current user's avatar from storage.
 */
export async function deleteAvatar(userId: string): Promise<boolean> {
  // List files in user's folder
  const { data: files } = await supabase.storage
    .from('avatars')
    .list(userId);

  if (!files || files.length === 0) return true;

  const paths = files.map((f) => `${userId}/${f.name}`);
  const { error } = await supabase.storage
    .from('avatars')
    .remove(paths);

  return !error;
}

/**
 * Change the current user's password.
 */
export async function changePassword(
  newPassword: string,
): Promise<{ success: boolean; error?: string }> {
  const { error } = await supabase.auth.updateUser({
    password: newPassword,
  });

  if (error) {
    return { success: false, error: error.message };
  }
  return { success: true };
}
