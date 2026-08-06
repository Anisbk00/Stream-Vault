'use client';

import { useState, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
import { BicepsFlexed, Eye, EyeOff, Loader2, LogIn, MonitorSmartphone, WifiOff, RefreshCw } from 'lucide-react';
import RetroShield from './RetroShield';
import { getMyProfile, getSupabaseConfig } from '@/lib/supabase';
import { registerSession } from '@/lib/session-manager';
import { useAuthStore } from '@/store';
import { createClient } from '@supabase/supabase-js';
import type { SessionResult } from '@/lib/session-manager';

// ── Error classification ────────────────────────────────────
// Maps Supabase/network errors to specific, actionable messages.
// This is the core fix for the "connection lost without evidence" issue.

type AuthErrorKind = 'network' | 'auth' | 'server' | 'timeout' | 'config' | 'unknown';

interface ClassifiedError {
  kind: AuthErrorKind;
  message: string;
  retryable: boolean;
}

function classifyAuthError(error: unknown): ClassifiedError {
  // Supabase AuthError
  if (error && typeof error === 'object' && 'message' in error) {
    const msg = String((error as { message: unknown }).message).toLowerCase();

    // Network / connection errors
    if (
      msg.includes('connection') ||
      msg.includes('network') ||
      msg.includes('fetch') ||
      msg.includes('failed to fetch') ||
      msg.includes('net::') ||
      msg.includes('err_connection') ||
      msg.includes('err_name_not_resolved') ||
      msg.includes('err_timed_out') ||
      msg.includes('unable to reach') ||
      msg.includes('request timed out') ||
      msg.includes('timeout')
    ) {
      console.warn('[AUTH] signIn error classified as NETWORK:', msg);
      return {
        kind: 'network',
        message: navigator.onLine
          ? 'Cannot reach the server. Try again in a moment.'
          : 'No internet connection. Check your network and try again.',
        retryable: true,
      };
    }

    // Auth-specific errors
    if (msg.includes('invalid login')) {
      return { kind: 'auth', message: 'Invalid email or password', retryable: false };
    }
    if (msg.includes('email not confirmed')) {
      return { kind: 'auth', message: 'Account not yet activated. Contact admin.', retryable: false };
    }
    if (msg.includes('too many requests') || msg.includes('rate limit')) {
      console.warn('[AUTH] signIn error classified as SERVER (rate limit):', msg);
      return { kind: 'server', message: 'Too many attempts. Wait a minute and try again.', retryable: true };
    }
    if (msg.includes('invalid api key') || msg.includes('jwt')) {
      console.warn('[AUTH] signIn error classified as CONFIG:', msg);
      return { kind: 'config', message: 'Server configuration error. Please contact support.', retryable: false };
    }

    // Generic Supabase error — likely server-side
    if (msg.includes('500') || msg.includes('internal') || msg.includes('unexpected')) {
      console.warn('[AUTH] signIn error classified as SERVER:', msg);
      return { kind: 'server', message: 'Server error. Please try again shortly.', retryable: true };
    }

    // Other Supabase errors
    console.warn('[AUTH] signIn error unclassified:', msg);
    return { kind: 'unknown', message: String((error as { message: unknown }).message), retryable: false };
  }

  // Non-Error throws (string, number, etc.)
  if (error instanceof TypeError && error.message.includes('fetch')) {
    console.warn('[AUTH] signIn TypeError (fetch):', error.message);
    return {
      kind: 'network',
      message: navigator.onLine
        ? 'Cannot reach the server. Try again in a moment.'
        : 'No internet connection. Check your network and try again.',
      retryable: true,
    };
  }

  console.warn('[AUTH] signIn unknown error:', error);
  return { kind: 'unknown', message: 'Sign in failed. Please try again.', retryable: false };
}

// ── Network readiness check ─────────────────────────────────
// After a device wakes from sleep, the network interface may
// not be fully ready even though navigator.onLine is true.
// This performs a lightweight connectivity probe to the Supabase
// health endpoint before attempting auth.

async function waitForNetworkReady(maxWaitMs = 5000): Promise<boolean> {
  if (!navigator.onLine) return false;

  // Quick check: try a lightweight fetch to verify DNS + TCP are ready.
  // Use the Supabase URL as the target since that's where auth calls go.
  const config = getSupabaseConfig();
  if (!config.url) return navigator.onLine;

  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      // HEAD request to Supabase root — lightweight, no auth needed
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      await fetch(config.url, { method: 'HEAD', mode: 'no-cors', signal: controller.signal });
      clearTimeout(timeout);
      return true; // Network is ready
    } catch {
      // Network not ready yet — wait 300ms and retry
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  return false; // Timed out
}

export default function LoginScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [emailError, setEmailError] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [sessionRejection, setSessionRejection] = useState<SessionResult | null>(null);
  const lastAuthRef = useRef<{ user: any; session: any } | null>(null);
  const retryCountRef = useRef(0);
  const MAX_RETRIES = 2;

  const setAuth = useAuthStore((s) => s.setAuth);
  const setProfile = useAuthStore((s) => s.setProfile);
  const setStatus = useAuthStore((s) => s.setStatus);

  const handleLogin = useCallback(async () => {
    const trimmedEmail = email.trim().toLowerCase();
    setEmailError('');
    setPasswordError('');

    if (!trimmedEmail) {
      setEmailError('Enter your email');
      return;
    }
    if (!password) {
      setPasswordError('Enter your password');
      return;
    }

    setIsLoading(true);

    // Safety timeout: if any step hangs (GoTrue race, network stall in
    // PWA), stop the spinner after 15 seconds and show an error.
    // In PWA standalone mode, a hung request leaves the user stuck on a
    // spinning button with no way to recover except force-closing the app.
    const timeoutId = setTimeout(() => {
      setIsLoading(false);
      retryCountRef.current = 0;
      setEmailError('Sign in timed out. Check your connection and try again.');
    }, 15_000);

    try {
      // ── Network readiness check ────────────────────────────
      // After device wake, DNS and TCP may not be ready even though
      // navigator.onLine is true. Probe the network first to avoid
      // the "connection lost" error that requires PWA reinstall.
      if (navigator.onLine) {
        const ready = await waitForNetworkReady(3000);
        if (!ready && !navigator.onLine) {
          setEmailError('No internet connection. Check your network and try again.');
          return;
        }
        // If probe timed out but navigator.onLine is still true,
        // proceed anyway — the auth call itself may succeed.
      } else {
        setEmailError('No internet connection. Check your network and try again.');
        return;
      }

      // Use a FRESH client for signIn, not the singleton.
      // The singleton's GoTrue client can hang indefinitely after page reload
      // (re-initialization race when initSupabase() resets _client).
      // A fresh client has no stale state and will never hang.
      // CRITICAL: use getSupabaseConfig() — NOT process.env — so the client
      // resolves credentials from window.__SV_CONFIG__ (injected by layout)
      // or explicit init. process.env.NEXT_PUBLIC_* is baked at build time
      // and is EMPTY/STALE in a cached PWA shell, causing auth calls to fail
      // with "Connection error. Check your internet."
      // CRITICAL: use the same storageKey so the session is written to
      // the same localStorage key that getAuthToken() reads from.
      const signInConfig = getSupabaseConfig();
      if (!signInConfig.url || !signInConfig.key) {
        setEmailError('App not configured. Please reload the page.');
        return;
      }

      const signInClient = createClient(
        signInConfig.url,
        signInConfig.key,
        { auth: { storageKey: 'movera-auth-token', storage: typeof window !== 'undefined' ? window.localStorage : undefined } },
      );
      const { data, error } = await signInClient.auth.signInWithPassword({
        email: trimmedEmail,
        password,
      });

      if (error) {
        const classified = classifyAuthError(error);

        if (classified.kind === 'auth') {
          // Auth errors go to password field
          setPasswordError(classified.message);
        } else {
          // All other errors go to email field (top of form)
          setEmailError(classified.message);
        }

        // Auto-retry for retryable errors (network, server)
        if (classified.retryable && retryCountRef.current < MAX_RETRIES) {
          retryCountRef.current++;
          // Wait with exponential backoff before retrying
          const backoffMs = 1000 * Math.pow(2, retryCountRef.current - 1);
          await new Promise((r) => setTimeout(r, backoffMs));
          // Recursive call — the timeout guard above still applies
          clearTimeout(timeoutId);
          setIsLoading(false);
          handleLogin();
          return;
        }

        // Non-retryable or max retries reached
        if (classified.retryable && retryCountRef.current >= MAX_RETRIES) {
          setEmailError((prev) => prev + ' (tried ' + (retryCountRef.current + 1) + ' times)');
        }

        retryCountRef.current = 0;
        return;
      }

      // Auth successful — reset retry counter
      retryCountRef.current = 0;

      // Auth successful — set user/session in store
      setAuth(data.user, data.session);
      lastAuthRef.current = { user: data.user, session: data.session };
      setSessionRejection(null);

      // Check user metadata flag first — this bypasses RLS entirely
      // and survives data clears. If set, profile was completed before.
      const metaCompleted = !!data.user.user_metadata?.profile_completed;

      // Fetch profile from DB using the FRESH signIn client, not the
      // singleton. After logout(), resetSupabaseClient() nulls the
      // singleton, and the next getMyProfile() triggers singleton
      // recreation. The new singleton's GoTrue client can hang
      // indefinitely on getSession() in PWA mode (re-initialization race).
      // The fresh signIn client already has a valid session in memory,
      // so its getSession() returns instantly — no hang possible.
      let profile: Awaited<ReturnType<typeof getMyProfile>> = null;
      try {
        const { data: { session: freshSession } } = await signInClient.auth.getSession();
        if (freshSession?.access_token && freshSession.user?.id) {
          const { data: profileData } = await signInClient
            .from('profiles')
            .select('*')
            .eq('id', freshSession.user.id)
            .maybeSingle();
          if (profileData) {
            profile = { ...profileData, is_complete: profileData.display_name.trim().length > 0 };
          }
        }
      } catch (profileErr) {
        // Profile fetch failed — non-critical. If metaCompleted is true
        // the user still gets in. If not, they'll see needs_profile.
        // Log for diagnostics but don't block login.
        const classified = classifyAuthError(profileErr);
        if (classified.kind === 'network') {
          // Network issue during profile fetch — still allow login
          // The profile will be re-fetched on next heartbeat/online event
        }
      }
      setProfile(profile);

      // Register this device session — MUST await to check for rejection.
      // Pass token directly from signInWithPassword response to avoid
      // getSession() race condition (especially in private/incognito tabs).
      // - active: true + tracked: true → session registered, limit enforced ✓
      // - active: false + rejected: true → too many devices, show rejection UI ✗
      // - active: true + tracked: false → DB can't enforce, allow login (fail-open)
      // - null → network/server error, allow login (fail-open, don't lock out)
      const sessionResult = await registerSession(false, data.session.access_token);

      if (sessionResult?.rejected && !sessionResult.active) {
        // Hard rejection — max sessions reached.
        // Don't sign out — keep Supabase session so force-login can work.
        // Show rejection UI with "Sign out all devices" button.
        setSessionRejection(sessionResult);
        return;
      }
      // null (network error) or active: true → allow login

      if (metaCompleted || (profile && profile.display_name.trim().length > 0)) {
        setStatus('authenticated');
        toast.success('Welcome back!');
      } else {
        setStatus('needs_profile');
      }
    } catch (err) {
      const classified = classifyAuthError(err);

      if (classified.kind === 'auth') {
        setPasswordError(classified.message);
      } else {
        setEmailError(classified.message);
      }

      // Auto-retry for transient errors
      if (classified.retryable && retryCountRef.current < MAX_RETRIES) {
        retryCountRef.current++;
        const backoffMs = 1000 * Math.pow(2, retryCountRef.current - 1);
        await new Promise((r) => setTimeout(r, backoffMs));
        clearTimeout(timeoutId);
        setIsLoading(false);
        handleLogin();
        return;
      }

      if (classified.retryable && retryCountRef.current >= MAX_RETRIES) {
        setEmailError((prev) => prev ? prev + ' (retry failed)' : classified.message + ' (retry failed)');
      }

      retryCountRef.current = 0;
    } finally {
      clearTimeout(timeoutId);
      setIsLoading(false);
    }
  }, [email, password, setAuth, setProfile, setStatus]);

  const handleForceLogin = useCallback(async () => {
    if (!lastAuthRef.current) return;
    setIsLoading(true);
    try {
      // Network readiness check before force login too
      if (navigator.onLine) {
        await waitForNetworkReady(3000);
      }

      const result = await registerSession(true, lastAuthRef.current.session.access_token);
      if (result?.active) {
        setSessionRejection(null);
        const { user, session } = lastAuthRef.current;
        const metaCompleted = !!user.user_metadata?.profile_completed;
        // Fetch profile using a fresh client (same reason as handleLogin —
        // singleton may hang after resetSupabaseClient in PWA mode).
        let profile: Awaited<ReturnType<typeof getMyProfile>> = null;
        try {
          const forceConfig = getSupabaseConfig();
          const freshClient = createClient(
            forceConfig.url,
            forceConfig.key,
            { auth: { storageKey: 'movera-auth-token', storage: typeof window !== 'undefined' ? window.localStorage : undefined } },
          );
          const { data: { session: freshSession } } = await freshClient.auth.getSession();
          if (freshSession?.access_token && freshSession.user?.id) {
            const { data: profileData } = await freshClient
              .from('profiles')
              .select('*')
              .eq('id', freshSession.user.id)
              .maybeSingle();
            if (profileData) {
              profile = { ...profileData, is_complete: profileData.display_name.trim().length > 0 };
            }
          }
        } catch { /* non-critical */ }
        setProfile(profile);
        if (metaCompleted || (profile && profile.display_name.trim().length > 0)) {
          setStatus('authenticated');
          toast.success('Signed in! All other devices have been signed out.', { duration: 4000 });
        } else {
          setStatus('needs_profile');
        }
      } else {
        const classified = classifyAuthError(result);
        toast.error(classified.kind === 'network'
          ? 'Cannot reach the server. Check your connection.'
          : 'Could not sign out other devices. Try again.');
      }
    } catch (err) {
      const classified = classifyAuthError(err);
      toast.error(classified.kind === 'network'
        ? 'No internet connection. Check your network.'
        : classified.message);
    } finally {
      setIsLoading(false);
    }
  }, [setProfile, setStatus]);

  const handleCancelRejection = useCallback(async () => {
    setSessionRejection(null);
    // Use fresh client to avoid GoTrue hang on the singleton.
    // Same storageKey ensures signOut clears the session from the
    // same localStorage key that the rest of the app reads.
    const cancelConfig = getSupabaseConfig();
    const freshClient = createClient(
      cancelConfig.url,
      cancelConfig.key,
      { auth: { storageKey: 'movera-auth-token', storage: typeof window !== 'undefined' ? window.localStorage : undefined } },
    );
    await freshClient.auth.signOut();
    setAuth(null, null);
    setProfile(null);
    setStatus('unauthenticated');
    lastAuthRef.current = null;
  }, [setAuth, setProfile, setStatus]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !isLoading) handleLogin();
  }, [handleLogin, isLoading]);

  return (
    <div className="flex items-center justify-center flex-1 min-h-0 px-6">
      <motion.div
        initial={{ opacity: 0, y: 30 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: 'easeOut' }}
        className="w-full max-w-sm"
      >
        {/* Logo — matches splash screen: amber shield on dark, no background box */}
        <div className="flex flex-col items-center mb-8">
          <div className="mb-4">
            <RetroShield
              className="size-14"
              style={{ color: '#D97706' }}
              strokeWidth={1.2}
            />
          </div>
          <h1 className="text-2xl font-bold tracking-[0.2em] uppercase" style={{ color: '#D97706' }}>
            Movera
          </h1>
          <p className="text-sm text-[#808080] mt-1">Sign in to continue</p>
        </div>

        {/* Form */}
        <div className="space-y-4">
          {/* Email */}
          <div>
            <label htmlFor="login-email" className="sr-only">Email</label>
            <input
              id="login-email"
              type="email"
              value={email}
              onChange={(e) => { setEmail(e.target.value); if (emailError) setEmailError(''); }}
              onKeyDown={handleKeyDown}
              autoComplete="email"
              placeholder="Email"
              disabled={isLoading}
              className={`w-full bg-white/[0.06] border rounded-xl px-4 py-3.5 text-[15px] text-[#F5F5F5] placeholder:text-[#505050] outline-none transition-colors disabled:opacity-50 ${emailError ? 'border-[#D97706]/60 focus:border-[#D97706]' : 'border-white/[0.12] focus:border-sv-red/50'}`}
            />
            <AnimatePresence>
              {emailError && (
                <motion.p
                  initial={{ opacity: 0, height: 0, marginTop: 0 }}
                  animate={{ opacity: 1, height: 'auto', marginTop: 6 }}
                  exit={{ opacity: 0, height: 0, marginTop: 0 }}
                  transition={{ duration: 0.2 }}
                  className="text-[12px] text-[#D97706] leading-snug overflow-hidden"
                >
                  {emailError}
                </motion.p>
              )}
            </AnimatePresence>
          </div>

          {/* Password */}
          <div className="relative">
            <label htmlFor="login-password" className="sr-only">Password</label>
            <input
              id="login-password"
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(e) => { setPassword(e.target.value); if (passwordError) setPasswordError(''); }}
              onKeyDown={handleKeyDown}
              autoComplete="current-password"
              placeholder="Password"
              disabled={isLoading}
              className={`w-full bg-white/[0.06] border rounded-xl px-4 py-3.5 pr-12 text-[15px] text-[#F5F5F5] placeholder:text-[#505050] outline-none transition-colors disabled:opacity-50 ${passwordError ? 'border-[#D97706]/60 focus:border-[#D97706]' : 'border-white/[0.12] focus:border-sv-red/50'}`}
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-[#606060] hover:text-[#A0A0A0] transition-colors cursor-pointer p-1"
              tabIndex={-1}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
            >
              {showPassword ? <EyeOff className="size-5" /> : <Eye className="size-5" />}
            </button>
            <AnimatePresence>
              {passwordError && (
                <motion.p
                  initial={{ opacity: 0, height: 0, marginTop: 0 }}
                  animate={{ opacity: 1, height: 'auto', marginTop: 6 }}
                  exit={{ opacity: 0, height: 0, marginTop: 0 }}
                  transition={{ duration: 0.2 }}
                  className="text-[12px] text-[#D97706] leading-snug overflow-hidden"
                >
                  {passwordError}
                </motion.p>
              )}
            </AnimatePresence>
          </div>

          {/* Submit */}
          <button
            onClick={handleLogin}
            disabled={isLoading || !email.trim() || !password || !!sessionRejection}
            className="w-full flex items-center justify-center gap-2 bg-sv-red hover:bg-sv-red-hover disabled:opacity-30 disabled:hover:bg-sv-red text-white font-semibold px-6 py-3.5 rounded-xl transition-colors cursor-pointer press-effect"
          >
            {isLoading ? (
              <Loader2 className="size-5 animate-spin" />
            ) : (
              <LogIn className="size-5" />
            )}
            {isLoading ? (retryCountRef.current > 0 ? 'Retrying...' : 'Signing in...') : 'Sign In'}
          </button>
        </div>

        {/* Session rejection warning */}
        <AnimatePresence>
          {sessionRejection && (
            <motion.div
              initial={{ opacity: 0, height: 0, marginTop: 0 }}
              animate={{ opacity: 1, height: 'auto', marginTop: 16 }}
              exit={{ opacity: 0, height: 0, marginTop: 0 }}
              transition={{ duration: 0.3 }}
              className="overflow-hidden"
            >
              <div className="bg-white/[0.06] border border-white/[0.12] rounded-xl p-4 space-y-3">
                <div className="flex items-start gap-3">
                  <MonitorSmartphone className="size-5 text-[#D97706] shrink-0 mt-0.5" />
                  <div className="min-w-0">
                    <p className="text-[13px] font-medium text-[#F5F5F5]">
                      Too many devices
                    </p>
                    <p className="text-[12px] text-[#808080] mt-1 leading-relaxed">
                      {sessionRejection.reason || 'You are signed in on 2 devices. Sign out from one of them to sign in here.'}
                    </p>
                  </div>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={handleForceLogin}
                    disabled={isLoading}
                    className="flex-1 flex items-center justify-center gap-2 bg-sv-red hover:bg-sv-red-hover disabled:opacity-50 disabled:hover:bg-sv-red text-white text-[13px] font-semibold px-4 py-2.5 rounded-lg transition-colors cursor-pointer press-effect whitespace-nowrap"
                  >
                    {isLoading ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <LogIn className="size-4" />
                    )}
                    {isLoading ? 'Signing in...' : 'Sign out all & sign in'}
                  </button>
                  <button
                    onClick={handleCancelRejection}
                    disabled={isLoading}
                    className="flex-1 text-[13px] text-[#808080] hover:text-[#F5F5F5] font-medium px-4 py-2.5 rounded-lg border border-white/[0.12] hover:border-white/[0.2] transition-colors cursor-pointer disabled:opacity-50"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Footer */}
        <p className="text-center text-[11px] text-[#404040] mt-8 flex items-center justify-center gap-1">
          Private VIP access only · Made with <BicepsFlexed className="size-3 text-[#404040]" /> by <span className="text-[#606060] font-medium">Anis</span>
        </p>
      </motion.div>
    </div>
  );
}
