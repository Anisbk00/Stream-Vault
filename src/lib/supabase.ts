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
 * Called once from StreamVaultApp with props from the Server Component.
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
      storageKey: 'streamvault-auth-token',
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
