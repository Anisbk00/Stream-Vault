/**
 * StreamVault — Watch Party Types
 *
 * Shared type definitions for the watch party feature.
 * Used by store, hook, UI components, and Supabase Realtime.
 */

// ── Party ──────────────────────────────────────────────────

export interface PartyMember {
  userId: string
  displayName: string
  avatarUrl: string | null
  isHost: boolean
  isTalking: boolean
  /** Current membership status: 'joined' or 'invited' */
  memberStatus?: 'joined' | 'invited'
}

export interface PlaybackState {
  isPlaying: boolean
  currentTime: number
  duration: number
  pausedBy: string | null
}

export interface WatchPartyData {
  id: string
  hostId: string
  contentId: string | null
  mediaType: 'movie' | 'tv' | null
  season: number | null
  episode: number | null
  contentTitle: string | null
  contentPoster: string | null
  status: 'waiting' | 'playing' | 'ended'
  members: PartyMember[]
  playbackState: PlaybackState
  createdAt: number
}

// ── Invitation ─────────────────────────────────────────────

export interface WatchPartyInvitation {
  partyId: string
  hostId: string
  hostName: string
  hostAvatarUrl: string | null
  memberCount: number
  receivedAt: number
}

// ── Overlay notification types ─────────────────────────────

export interface PauseNotification {
  pausedByName: string
  currentTime: number
}
