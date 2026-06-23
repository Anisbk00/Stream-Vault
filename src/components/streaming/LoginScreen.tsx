'use client';

import { useState, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
import { BicepsFlexed, Eye, EyeOff, Loader2, LogIn, MonitorSmartphone } from 'lucide-react';
import RetroShield from './RetroShield';
import { getMyProfile } from '@/lib/supabase';
import { registerSession } from '@/lib/session-manager';
import { useAuthStore } from '@/store';
import { createClient } from '@supabase/supabase-js';
import type { SessionResult } from '@/lib/session-manager';

export default function LoginScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [emailError, setEmailError] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [sessionRejection, setSessionRejection] = useState<SessionResult | null>(null);
  const lastAuthRef = useRef<{ user: any; session: any } | null>(null);

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
      setEmailError('Sign in timed out. Check your connection and try again.');
    }, 15_000);

    try {
      // Use a FRESH client for signIn, not the singleton.
      // The singleton's GoTrue client can hang indefinitely after page reload
      // (re-initialization race when initSupabase() resets _client).
      // A fresh client has no stale state and will never hang.
      // CRITICAL: use the same storageKey so the session is written to
      // the same localStorage key that getAuthToken() reads from.
      const signInClient = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL || '',
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '',
        { auth: { storageKey: 'streamvault-auth-token', storage: typeof window !== 'undefined' ? window.localStorage : undefined } },
      );
      const { data, error } = await signInClient.auth.signInWithPassword({
        email: trimmedEmail,
        password,
      });

      if (error) {
        if (error.message.includes('Invalid login')) {
          setPasswordError('Invalid email or password');
        } else if (error.message.includes('Email not confirmed')) {
          setEmailError('Account not yet activated. Contact admin.');
        } else {
          setEmailError(error.message);
        }
        return;
      }

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
      } catch {
        // Profile fetch failed — non-critical. If metaCompleted is true
        // the user still gets in. If not, they'll see needs_profile.
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
      setEmailError('Sign in failed. Please try again.');
    } finally {
      clearTimeout(timeoutId);
      setIsLoading(false);
    }
  }, [email, password, setAuth, setProfile, setStatus]);

  const handleForceLogin = useCallback(async () => {
    if (!lastAuthRef.current) return;
    setIsLoading(true);
    try {
      const result = await registerSession(true, lastAuthRef.current.session.access_token);
      if (result?.active) {
        setSessionRejection(null);
        const { user, session } = lastAuthRef.current;
        const metaCompleted = !!user.user_metadata?.profile_completed;
        // Fetch profile using a fresh client (same reason as handleLogin —
        // singleton may hang after resetSupabaseClient in PWA mode).
        let profile: Awaited<ReturnType<typeof getMyProfile>> = null;
        try {
          const freshClient = createClient(
            process.env.NEXT_PUBLIC_SUPABASE_URL || '',
            process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '',
            { auth: { storageKey: 'streamvault-auth-token', storage: typeof window !== 'undefined' ? window.localStorage : undefined } },
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
        toast.error('Could not sign out other devices. Try again.');
      }
    } catch {
      toast.error('Connection error. Check your internet.');
    } finally {
      setIsLoading(false);
    }
  }, [setProfile, setStatus]);

  const handleCancelRejection = useCallback(async () => {
    setSessionRejection(null);
    // Use fresh client to avoid GoTrue hang on the singleton.
    // Same storageKey ensures signOut clears the session from the
    // same localStorage key that the rest of the app reads.
    const freshClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL || '',
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '',
      { auth: { storageKey: 'streamvault-auth-token', storage: typeof window !== 'undefined' ? window.localStorage : undefined } },
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
        {/* Logo */}
        <div className="flex flex-col items-center mb-8">
          <div className="w-14 h-14 rounded-2xl flex items-center justify-center mb-4" style={{ backgroundColor: '#D97706' }}>
            <RetroShield className="size-7 text-white" strokeWidth={1.5} />
          </div>
          <h1 className="text-2xl font-bold text-white tracking-tight">
            StreamVault
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
            {isLoading ? 'Signing in...' : 'Sign In'}
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
