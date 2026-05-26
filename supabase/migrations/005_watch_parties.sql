-- ============================================================
-- Migration: 005_watch_parties
-- Feature: Watch Party
-- ============================================================

-- ----------------------------------------------------------
-- 1. watch_parties table
-- ----------------------------------------------------------
CREATE TABLE watch_parties (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  host_id         UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  content_id      TEXT,
  media_type      TEXT,
  season          INTEGER,
  episode         INTEGER,
  content_title   TEXT,
  content_poster  TEXT,
  status          TEXT DEFAULT 'waiting' CHECK (status IN ('waiting', 'playing', 'ended')),
  playback_time   DOUBLE PRECISION DEFAULT 0,
  is_playing      BOOLEAN DEFAULT false,
  paused_by       UUID REFERENCES profiles(id),
  created_at      TIMESTAMPTZ DEFAULT now(),
  ended_at        TIMESTAMPTZ
);

-- ----------------------------------------------------------
-- 2. watch_party_members table
-- ----------------------------------------------------------
CREATE TABLE watch_party_members (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  party_id    UUID NOT NULL REFERENCES watch_parties(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  status      TEXT DEFAULT 'invited' CHECK (status IN ('invited', 'joined', 'left', 'rejected')),
  joined_at   TIMESTAMPTZ,
  UNIQUE(party_id, user_id)
);

-- ----------------------------------------------------------
-- 3. Row-Level Security
-- ----------------------------------------------------------

-- Enable RLS
ALTER TABLE watch_parties ENABLE ROW LEVEL SECURITY;
ALTER TABLE watch_party_members ENABLE ROW LEVEL SECURITY;

-- watch_parties policies
CREATE POLICY "Anyone authenticated can read watch_parties"
  ON watch_parties FOR SELECT
  TO authenticated
  USING (true);

-- CRITICAL: INSERT policy — allows authenticated users to create parties.
-- Without this, RLS blocks ALL inserts and Watch Party creation silently fails.
CREATE POLICY "Authenticated users can create parties"
  ON watch_parties FOR INSERT
  TO authenticated
  WITH CHECK (host_id = auth.uid());

CREATE POLICY "Only host can update their own watch_parties"
  ON watch_parties FOR UPDATE
  TO authenticated
  USING (host_id = auth.uid())
  WITH CHECK (host_id = auth.uid());

CREATE POLICY "Only host can delete their own watch_parties"
  ON watch_parties FOR DELETE
  TO authenticated
  USING (host_id = auth.uid());

-- watch_party_members policies
CREATE POLICY "Anyone authenticated can read watch_party_members"
  ON watch_party_members FOR SELECT
  TO authenticated
  USING (true);

-- CRITICAL: INSERT policy — host must be able to insert records for OTHER users
-- (inviting them to the party). The EXISTS check verifies the inserter is the
-- party host. Without this, only self-joins work and inviting others is blocked by RLS.
CREATE POLICY "Host can invite, users can accept"
  ON watch_party_members FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM watch_parties p
      WHERE p.id = watch_party_members.party_id
        AND p.host_id = auth.uid()
    )
    OR user_id = auth.uid()
  );

-- UPDATE: users can update own status (accept/reject/leave), host can manage members
CREATE POLICY "Users manage own membership, host manages party members"
  ON watch_party_members FOR UPDATE
  TO authenticated
  USING (
    user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM watch_parties p
      WHERE p.id = watch_party_members.party_id
        AND p.host_id = auth.uid()
    )
  )
  WITH CHECK (
    user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM watch_parties p
      WHERE p.id = watch_party_members.party_id
        AND p.host_id = auth.uid()
    )
  );

-- ----------------------------------------------------------
-- 4. Indexes
-- ----------------------------------------------------------
CREATE INDEX idx_watch_parties_host_id ON watch_parties(host_id);
CREATE INDEX idx_watch_party_members_party_id ON watch_party_members(party_id);
CREATE INDEX idx_watch_party_members_user_id ON watch_party_members(user_id);
