-- StreamVault RLS — Comprehensive, idempotent setup
-- Run this in Supabase SQL Editor. Safe to run multiple times.
-- Fixes: 406 on profiles, watchlist not persisting to database

DO $$
BEGIN
  -- ─── PROFILES TABLE ───────────────────────────────────────
  ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

  DROP POLICY IF EXISTS "Authenticated users can read profiles" ON public.profiles;
  CREATE POLICY "Authenticated users can read profiles" ON public.profiles
    FOR SELECT TO authenticated USING (true);

  DROP POLICY IF EXISTS "Users can insert own profile" ON public.profiles;
  CREATE POLICY "Users can insert own profile" ON public.profiles
    FOR INSERT TO authenticated WITH CHECK (auth.uid() = id);

  DROP POLICY IF EXISTS "Users can update own profile" ON public.profiles;
  CREATE POLICY "Users can update own profile" ON public.profiles
    FOR UPDATE TO authenticated USING (auth.uid() = id) WITH CHECK (auth.uid() = id);

  -- ─── WATCHLIST TABLE ─────────────────────────────────────
  ALTER TABLE public.watchlist ENABLE ROW LEVEL SECURITY;

  DROP POLICY IF EXISTS "Authenticated users can read watchlist" ON public.watchlist;
  CREATE POLICY "Authenticated users can read watchlist" ON public.watchlist
    FOR SELECT TO authenticated USING (true);

  DROP POLICY IF EXISTS "Users can insert own watchlist" ON public.watchlist;
  CREATE POLICY "Users can insert own watchlist" ON public.watchlist
    FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);

  DROP POLICY IF EXISTS "Users can update own watchlist" ON public.watchlist;
  CREATE POLICY "Users can update own watchlist" ON public.watchlist
    FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

  DROP POLICY IF EXISTS "Users can delete own watchlist" ON public.watchlist;
  CREATE POLICY "Users can delete own watchlist" ON public.watchlist
    FOR DELETE TO authenticated USING (auth.uid() = user_id);
END $$;
