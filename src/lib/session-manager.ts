/**
 * Session Manager — enforces max 2 concurrent device sessions per user.
 *
 * Flow:
 *  1. On login: call registerSession() → server registers this device.
 *     If 2 sessions already exist, the new session is REJECTED (not evicted).
 *  2. Periodic heartbeat: call heartbeatSession() every 90s + on app foreground.
 *  3. If heartbeat returns { active: false } → session was removed → sign out.
 *  4. On logout: call destroySession() to clean up.
 *
 * The device_session_id is persisted in localStorage so it survives page reloads.
 * Clearing localStorage generates a new ID (counts as a new device).
 */

const DEVICE_SESSION_KEY = 'sv_device_session_id';
const HEARTBEAT_INTERVAL_MS = 10 * 1000; // 10 seconds — fast eviction detection
const SESSION_ENDPOINT = '/api/auth/session';

// Must match the storageKey used in supabase.ts client config
const SUPABASE_SESSION_STORAGE_KEY = 'streamvault-auth-token';

// ── Device session ID ────────────────────────────────────────

export function getDeviceSessionId(): string {
  if (typeof window === 'undefined') return '';
  let id = localStorage.getItem(DEVICE_SESSION_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(DEVICE_SESSION_KEY, id);
  }
  return id;
}

// ── Helpers ──────────────────────────────────────────────────

function getDeviceDescription(): string {
  if (typeof navigator === 'undefined') return '';
  const ua = navigator.userAgent;
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/iPad/i.test(ua)) return 'iPad';
  if (/Android/i.test(ua)) return 'Android';
  if (/Macintosh/i.test(ua)) return 'macOS';
  if (/Windows/i.test(ua)) return 'Windows';
  if (/Linux/i.test(ua)) return 'Linux';
  return 'Unknown';
}

/**
 * Get the current auth token.
 *
 * IMPORTANT: supabase.auth.getSession() can hang indefinitely after a page
 * reload (GoTrue client re-initialization race). To avoid blocking every
 * caller (All Users fetch, destroySession, watchlist sync, etc.), we read
 * the access_token directly from localStorage first — this is synchronous
 * and always resolves. The Supabase client stores its session under the
 * same key (streamvault-auth-token), so the token is always up-to-date.
 *
 * We only fall back to getSession() if localStorage doesn't have the token
 * (e.g. custom auth flow or storage migration).
 */
export async function getAuthToken(): Promise<string | null> {
  if (typeof window === 'undefined') return null;

  // ── Fast path: read directly from localStorage (synchronous) ──
  try {
    const raw = localStorage.getItem(SUPABASE_SESSION_STORAGE_KEY);
    if (raw) {
      const session = JSON.parse(raw);
      const token = session?.access_token;
      if (token && typeof token === 'string') {
        return token;
      }
    }
  } catch {
    // localStorage read/parse failed — fall through to getSession()
  }

  // ── Slow path: ask Supabase client (handles edge cases) ──
  try {
    const { supabase } = await import('@/lib/supabase');
    const { data, error } = await supabase.auth.getSession();
    if (error) return null;
    return data.session?.access_token ?? null;
  } catch {
    return null;
  }
}

export interface SessionResult {
  active: boolean;
  session_count: number;
  evicted?: boolean;
  evicted_session_id?: string;
  rejected?: boolean;
  tracked?: boolean;
  reason?: string;
  forced?: boolean;
}

// ── Register a new session (called after successful login) ──

export async function registerSession(force = false, accessToken?: string): Promise<SessionResult | null> {
  // Prefer caller-provided token (avoids getSession() race condition in private tabs)
  const token = accessToken || await getAuthToken();
  if (!token) return null;

  const sessionId = getDeviceSessionId();
  const deviceInfo = getDeviceDescription();

  try {
    const res = await fetch(SESSION_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        session_id: sessionId,
        device_info: deviceInfo,
        force,
      }),
    });

    if (!res.ok) {
      // 403 = session rejected (max sessions or insert failure).
      if (res.status === 403) {
        try {
          const result = (await res.json()) as SessionResult;
          if (result.rejected) {
            try { localStorage.removeItem(DEVICE_SESSION_KEY); } catch { /* ignore */ }
            return result;
          }
        } catch { /* fall through to null */ }
      }
      return null;
    }

    const result = (await res.json()) as SessionResult;

    // If session was rejected (max sessions reached), clear local device ID
    if (result.rejected) {
      try { localStorage.removeItem(DEVICE_SESSION_KEY); } catch { /* ignore */ }
    }

    // If session tracking is unavailable (tracked: false), signal to caller
    return result;
  } catch {
    return null;
  }
}

// ── Heartbeat (called periodically + on foreground) ─────────

export async function heartbeatSession(): Promise<SessionResult | null> {
  const token = await getAuthToken();
  if (!token) return null;

  const sessionId = getDeviceSessionId();
  if (!sessionId) return null;

  try {
    const res = await fetch(SESSION_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        session_id: sessionId,
        device_info: getDeviceDescription(),
        heartbeat: true,
      }),
    });

    if (!res.ok) return null;
    const result = (await res.json()) as SessionResult;
    // Heartbeat for evicted session → server returns active: false
    if (!result.active) return result;
    return result;
  } catch {
    return null;
  }
}

// ── Destroy session (called on logout) ──────────────────────

export async function destroySession(): Promise<void> {
  const token = await getAuthToken();
  const sessionId = getDeviceSessionId();
  if (!token || !sessionId) return;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    await fetch(SESSION_ENDPOINT, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ session_id: sessionId }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
  } catch {
    // Silent — cleanup is best-effort, never block logout
  }
}

// ── Heartbeat hook logic (called from StreamVaultApp) ───────
// Returns a cleanup function that clears the interval.

let _heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let _visibilityHandler: (() => void) | null = null;
let _currentSessionId: string | null = null;

export function startHeartbeat(onEvicted: () => void): () => void {
  stopHeartbeat();

  const sessionId = getDeviceSessionId();
  _currentSessionId = sessionId;

  // Periodic heartbeat every 10 seconds
  _heartbeatTimer = setInterval(async () => {
    const result = await heartbeatSession();
    if (result && !result.active) {
      // Only evict on explicit eviction signal (another device force-logged).
      if (result.evicted) {
        onEvicted();
      }
    }
  }, HEARTBEAT_INTERVAL_MS);

  // Also heartbeat when tab becomes visible (user returns to app)
  _visibilityHandler = async () => {
    if (document.visibilityState !== 'visible') return;

    // Check if session ID was cleared (e.g. by another tab logging in)
    const currentId = getDeviceSessionId();
    if (currentId !== _currentSessionId) {
      onEvicted();
      return;
    }

    const result = await heartbeatSession();
    if (result && !result.active && result.evicted) {
      // Only evict if the server explicitly confirms eviction.
      // If the session simply doesn't exist (stale purge), try to
      // re-register instead of logging out — the user is still valid.
      const token = await getAuthToken();
      if (token) {
        const reReg = await registerSession(false, token);
        if (reReg?.active) return; // Successfully re-registered
      }
      // Re-registration failed or rejected — evict
      onEvicted();
    }
  };

  document.addEventListener('visibilitychange', _visibilityHandler);

  // Return cleanup function
  return () => {
    stopHeartbeat();
  };
}

export function stopHeartbeat(): void {
  if (_heartbeatTimer) {
    clearInterval(_heartbeatTimer);
    _heartbeatTimer = null;
  }
  if (_visibilityHandler) {
    document.removeEventListener('visibilitychange', _visibilityHandler);
    _visibilityHandler = null;
  }
  _currentSessionId = null;
}
