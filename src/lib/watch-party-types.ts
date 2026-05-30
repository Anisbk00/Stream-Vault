/**
 * StreamVault — Watch Party Types
 *
 * Shared type definitions for the watch party feature.
 * Used by store, hook, UI components, and socket service.
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

// ── Socket events (client → server) ───────────────────────

export type WpClientEvents = {
  'wp:create-room': (callback: (response: { partyId: string; party: WatchPartyData }) => void) => void
  'wp:invite': (data: { partyId: string; targetUserId: string }, callback: (response: { success?: boolean; error?: string }) => void) => void
  'wp:accept-invite': (data: { partyId: string }, callback: (response: { party?: WatchPartyData; error?: string }) => void) => void
  'wp:reject-invite': (data: { partyId: string; hostId: string }) => void
  'wp:pick-content': (data: {
    contentId: string
    mediaType: 'movie' | 'tv'
    season?: number
    episode?: number
    contentTitle: string
    contentPoster?: string
  }, callback: (response: { success?: boolean; error?: string }) => void) => void
  'wp:start-party': (data: { currentTime?: number }, callback: (response: { success?: boolean; error?: string }) => void) => void
  'wp:sync': (data: { currentTime: number; isPlaying: boolean; duration: number }) => void
  'wp:pause': (data: { currentTime: number }) => void
  'wp:play': (data: { currentTime: number }, callback?: (response: { success?: boolean; error?: string }) => void) => void
  'wp:seek': (data: { currentTime: number }, callback?: (response: { success?: boolean; error?: string }) => void) => void
  'wp:ptt-start': () => void
  'wp:ptt-stop': () => void
  'wp:voice-offer': (data: { targetUserId: string; offer: RTCSessionDescriptionInit }) => void
  'wp:voice-answer': (data: { targetUserId: string; answer: RTCSessionDescriptionInit }) => void
  'wp:voice-ice': (data: { targetUserId: string; candidate: RTCIceCandidateInit }) => void
  'wp:leave': () => void
  'wp:end': (callback?: (response: { success?: boolean; error?: string }) => void) => void
}

// ── Socket events (server → client) ───────────────────────

export type WpServerEvents = {
  'wp:invitation': (data: WatchPartyInvitation) => void
  'wp:invite-rejected': (data: { partyId: string; userId: string; displayName: string }) => void
  'wp:member-joined': (data: { member: PartyMember; members: PartyMember[] }) => void
  'wp:member-left': (data: { userId: string; displayName: string; members: PartyMember[] }) => void
  'wp:content-picked': (data: {
    contentId: string
    mediaType: 'movie' | 'tv'
    season: number | null
    episode: number | null
    contentTitle: string
    contentPoster: string | null
  }) => void
  'wp:party-started': (data: { currentTime: number }) => void
  'wp:paused': (data: { pausedBy: string; pausedByName: string; currentTime: number }) => void
  'wp:played': (data: { currentTime: number; resumedBy: string; resumedByName: string }) => void
  'wp:seeked': (data: { currentTime: number; seekedBy: string; seekedByName: string }) => void
  'wp:member-talking': (data: { userId: string; isTalking: boolean }) => void
  'wp:pause-released': (data: { reason: string; members: PartyMember[] }) => void
  'wp:ended': (data: { endedBy: string }) => void
  'wp:voice-offer': (data: { fromUserId: string; offer: RTCSessionDescriptionInit }) => void
  'wp:voice-answer': (data: { fromUserId: string; answer: RTCSessionDescriptionInit }) => void
  'wp:voice-ice': (data: { fromUserId: string; candidate: RTCIceCandidateInit }) => void
}

// ── Overlay notification types ─────────────────────────────

export interface PauseNotification {
  pausedByName: string
  currentTime: number
}
