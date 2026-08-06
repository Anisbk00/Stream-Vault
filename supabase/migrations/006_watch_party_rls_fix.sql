-- ============================================================
-- Migration: 006_watch_party_rls_fix
-- Fix: Missing INSERT policy on watch_parties + overly
--      restrictive INSERT on watch_party_members.
-- Severity: HIGH — Watch Party invite feature is broken
--              without these policies.
--
-- Run this ONCE in Supabase SQL Editor.
-- Idempotent: uses DROP POLICY IF EXISTS before CREATE.
-- ============================================================

DO $$
BEGIN
  -- ─── watch_parties RLS ────────────────────────────────────

  ALTER TABLE public.watch_parties ENABLE ROW LEVEL SECURITY;

  -- SELECT: Anyone authenticated can read all parties
  -- (needed for invite discovery, member listing, etc.)
  DROP POLICY IF EXISTS "Anyone authenticated can read watch_parties" ON public.watch_parties;
  DROP POLICY IF EXISTS "Users can read parties they belong to" ON public.watch_parties;
  CREATE POLICY "Anyone authenticated can read watch_parties" ON public.watch_parties
    FOR SELECT TO authenticated USING (true);

  -- INSERT: Any authenticated user can create a party
  -- (they become the host — enforced by WITH CHECK host_id = auth.uid())
  DROP POLICY IF EXISTS "Authenticated users can create parties" ON public.watch_parties;
  CREATE POLICY "Authenticated users can create parties" ON public.watch_parties
    FOR INSERT TO authenticated WITH CHECK (host_id = auth.uid());

  -- UPDATE: Only the host can update party state
  DROP POLICY IF EXISTS "Only host can update their own watch_parties" ON public.watch_parties;
  DROP POLICY IF EXISTS "Host can update party" ON public.watch_parties;
  CREATE POLICY "Host can update party" ON public.watch_parties
    FOR UPDATE TO authenticated
    USING (host_id = auth.uid())
    WITH CHECK (host_id = auth.uid());

  -- DELETE: Only the host can delete a party
  DROP POLICY IF EXISTS "Only host can delete their own watch_parties" ON public.watch_parties;
  DROP POLICY IF EXISTS "Host can delete party" ON public.watch_parties;
  CREATE POLICY "Host can delete party" ON public.watch_parties
    FOR DELETE TO authenticated USING (host_id = auth.uid());

  -- ─── watch_party_members RLS ──────────────────────────────

  ALTER TABLE public.watch_party_members ENABLE ROW LEVEL SECURITY;

  -- SELECT: Anyone authenticated can read all member records
  -- (needed for member listing in party room, invite status, etc.)
  DROP POLICY IF EXISTS "Anyone authenticated can read watch_party_members" ON public.watch_party_members;
  DROP POLICY IF EXISTS "Users can read members of their parties" ON public.watch_party_members;
  CREATE POLICY "Anyone authenticated can read watch_party_members" ON public.watch_party_members
    FOR SELECT TO authenticated USING (true);

  -- INSERT: Host can invite members (inserts record for target user),
  --         OR a user can insert their own membership (self-join/accept).
  --         The EXISTS subquery verifies the inserter is the party host.
  DROP POLICY IF EXISTS "Users can insert their own membership record" ON public.watch_party_members;
  DROP POLICY IF EXISTS "Host can invite, users can accept" ON public.watch_party_members;
  CREATE POLICY "Host can invite, users can accept" ON public.watch_party_members
    FOR INSERT TO authenticated
    WITH CHECK (
      -- Host inviting someone to their party
      EXISTS (
        SELECT 1 FROM public.watch_parties p
        WHERE p.id = watch_party_members.party_id
          AND p.host_id = auth.uid()
      )
      OR
      -- User joining/accepting their own invite
      user_id = auth.uid()
    );

  -- UPDATE: Users can update their own membership status (accept/reject/leave),
  --         host can also update members in their party (kick, etc.)
  DROP POLICY IF EXISTS "Users can update their own membership status" ON public.watch_party_members;
  DROP POLICY IF EXISTS "Users manage own membership, host manages party members" ON public.watch_party_members;
  CREATE POLICY "Users manage own membership, host manages party members" ON public.watch_party_members
    FOR UPDATE TO authenticated
    USING (
      user_id = auth.uid()
      OR EXISTS (
        SELECT 1 FROM public.watch_parties p
        WHERE p.id = watch_party_members.party_id
          AND p.host_id = auth.uid()
      )
    )
    WITH CHECK (
      user_id = auth.uid()
      OR EXISTS (
        SELECT 1 FROM public.watch_parties p
        WHERE p.id = watch_party_members.party_id
          AND p.host_id = auth.uid()
      )
    );

  -- DELETE: Users can delete their own membership, host can remove members
  DROP POLICY IF EXISTS "Users delete own membership, host can remove" ON public.watch_party_members;
  CREATE POLICY "Users delete own membership, host can remove" ON public.watch_party_members
    FOR DELETE TO authenticated
    USING (
      user_id = auth.uid()
      OR EXISTS (
        SELECT 1 FROM public.watch_parties p
        WHERE p.id = watch_party_members.party_id
          AND p.host_id = auth.uid()
      )
    );
END $$;
