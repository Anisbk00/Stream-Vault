-- ── 004_user_sessions.sql ──────────────────────────────────────────────────
-- Track active device sessions per user. Enforce max 2 concurrent sessions
-- to prevent credential sharing.
--
-- Run this in Supabase Dashboard → SQL Editor.

CREATE TABLE IF NOT EXISTS public.user_sessions (
  id            BIGSERIAL       PRIMARY KEY,
  user_id       UUID            NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  session_id    TEXT            NOT NULL,          -- device-generated UUID (persisted in localStorage)
  device_info   TEXT            DEFAULT '',        -- user-agent or device name
  ip_address    INET,                              -- client IP (nullable for privacy)
  last_active   TIMESTAMPTZ     NOT NULL DEFAULT now(),
  created_at    TIMESTAMPTZ     NOT NULL DEFAULT now(),

  UNIQUE (user_id, session_id)                       -- one session_id per user
);

-- Indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id     ON public.user_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_sessions_last_active  ON public.user_sessions(last_active);

-- ── RLS ──────────────────────────────────────────────────────────────────────
ALTER TABLE public.user_sessions ENABLE ROW LEVEL SECURITY;

-- Users can read their own sessions
CREATE POLICY "users_select_own_sessions" ON public.user_sessions
  FOR SELECT USING (auth.uid() = user_id);

-- Users can insert their own sessions
CREATE POLICY "users_insert_own_sessions" ON public.user_sessions
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Users can update their own sessions (heartbeat)
CREATE POLICY "users_update_own_sessions" ON public.user_sessions
  FOR UPDATE USING (auth.uid() = user_id);

-- Users can delete their own sessions (logout)
CREATE POLICY "users_delete_own_sessions" ON public.user_sessions
  FOR DELETE USING (auth.uid() = user_id);

-- ── Helper: purge stale sessions (call periodically from API or cron) ────────
CREATE OR REPLACE FUNCTION public.purge_stale_sessions()
RETURNS void AS $$
  DELETE FROM public.user_sessions
  WHERE last_active < now() - INTERVAL '30 minutes';
$$ LANGUAGE sql SECURITY DEFINER;
