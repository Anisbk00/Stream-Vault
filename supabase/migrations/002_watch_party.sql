-- ============================================================
-- StreamVault — Watch Party Tables
-- Run this in Supabase SQL Editor
-- ============================================================

-- ── watch_parties ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.watch_parties (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  host_id uuid NOT NULL,
  content_id text,
  media_type text CHECK (media_type IN ('movie', 'tv')),
  season integer,
  episode integer,
  content_title text,
  content_poster text,
  status text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'playing', 'ended')),
  playback_time double precision NOT NULL DEFAULT 0,
  is_playing boolean NOT NULL DEFAULT false,
  paused_by uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  ended_at timestamp with time zone,

  CONSTRAINT watch_parties_pkey PRIMARY KEY (id),
  CONSTRAINT watch_parties_host_id_fkey FOREIGN KEY (host_id) REFERENCES public.profiles(id) ON DELETE CASCADE,
  CONSTRAINT watch_parties_paused_by_fkey FOREIGN KEY (paused_by) REFERENCES public.profiles(id) ON DELETE SET NULL
);

-- Index: look up parties by host
CREATE INDEX IF NOT EXISTS idx_watch_parties_host_id ON public.watch_parties(host_id);
-- Index: filter by status (active parties)
CREATE INDEX IF NOT EXISTS idx_watch_parties_status ON public.watch_parties(status);

-- ── watch_party_members ────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.watch_party_members (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  party_id uuid NOT NULL,
  user_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'joined', 'left', 'rejected')),
  joined_at timestamp with time zone,

  CONSTRAINT watch_party_members_pkey PRIMARY KEY (id),
  CONSTRAINT watch_party_members_party_id_fkey FOREIGN KEY (party_id) REFERENCES public.watch_parties(id) ON DELETE CASCADE,
  CONSTRAINT watch_party_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE,
  CONSTRAINT watch_party_members_unique_party_user UNIQUE (party_id, user_id)
);

-- Index: find a user's active memberships
CREATE INDEX IF NOT EXISTS idx_watch_party_members_user_status ON public.watch_party_members(user_id, status);
-- Index: find all members of a party
CREATE INDEX IF NOT EXISTS idx_watch_party_members_party_id ON public.watch_party_members(party_id);

-- ============================================================
-- RLS Policies
-- ============================================================

ALTER TABLE public.watch_parties ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.watch_party_members ENABLE ROW LEVEL SECURITY;

-- ── watch_parties policies ─────────────────────────────────

-- Anyone authenticated can read parties they're a member of (via subquery)
CREATE POLICY "Users can read parties they belong to"
  ON public.watch_parties FOR SELECT
  TO authenticated
  USING (
    host_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.watch_party_members m
      WHERE m.party_id = watch_parties.id
        AND m.user_id = auth.uid()
    )
  );

-- Any authenticated user can create a party (they become host)
CREATE POLICY "Authenticated users can create parties"
  ON public.watch_parties FOR INSERT
  TO authenticated
  WITH CHECK (host_id = auth.uid());

-- Only the host can update a party (change content, status, playback)
CREATE POLICY "Host can update party"
  ON public.watch_parties FOR UPDATE
  TO authenticated
  USING (host_id = auth.uid())
  WITH CHECK (host_id = auth.uid());

-- Only the host can delete a party
CREATE POLICY "Host can delete party"
  ON public.watch_parties FOR DELETE
  TO authenticated
  USING (host_id = auth.uid());

-- ── watch_party_members policies ───────────────────────────

-- Users can read members of parties they belong to
CREATE POLICY "Users can read members of their parties"
  ON public.watch_party_members FOR SELECT
  TO authenticated
  USING (
    user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.watch_parties p
      WHERE p.id = watch_party_members.party_id
        AND p.host_id = auth.uid()
    )
  );

-- Host can insert members (invites), users can insert themselves (accept)
CREATE POLICY "Host can invite, users can accept"
  ON public.watch_party_members FOR INSERT
  TO authenticated
  WITH CHECK (
    -- Host inviting someone to their party
    EXISTS (
      SELECT 1 FROM public.watch_parties p
      WHERE p.id = watch_party_members.party_id
        AND p.host_id = auth.uid()
    )
    OR
    -- User accepting their own invite
    user_id = auth.uid()
  );

-- Users can update their own membership status (accept/reject/leave)
-- Host can also update members in their party
CREATE POLICY "Users manage own membership, host manages party members"
  ON public.watch_party_members FOR UPDATE
  TO authenticated
  USING (
    user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.watch_parties p
      WHERE p.id = watch_party_members.party_id
        AND p.host_id = auth.uid()
    )
  );

-- Users can delete their own membership, host can remove members
CREATE POLICY "Users delete own membership, host can remove"
  ON public.watch_party_members FOR DELETE
  TO authenticated
  USING (
    user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.watch_parties p
      WHERE p.id = watch_party_members.party_id
        AND p.host_id = auth.uid()
    )
  );

-- ============================================================
-- Enable Realtime
-- ============================================================

-- Enable Realtime for watch_parties so clients can subscribe to changes
ALTER PUBLICATION supabase_realtime ADD TABLE public.watch_parties;
ALTER PUBLICATION supabase_realtime ADD TABLE public.watch_party_members;
