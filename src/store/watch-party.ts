/**
 * StreamVault — Watch Party Zustand Store
 *
 * Manages watch party state: current party, invitations, playback sync,
 * voice chat, and member tracking. Integrated with Supabase Realtime.
 */

import { create } from 'zustand'
import type {
  WatchPartyData,
  WatchPartyInvitation,
  PartyMember,
  PauseNotification,
} from '@/lib/watch-party-types'

// ── State Interface ────────────────────────────────────────

interface WatchPartyState {
  /** Current party the user is in (null if not in a party) */
  currentParty: WatchPartyData | null
  /** Pending invitations received (shown as overlay) */
  pendingInvitations: WatchPartyInvitation[]
  /** Whether the socket is connected */
  isConnected: boolean
  /** Whether the user is currently in a party */
  isInParty: boolean
  /** Whether the user is the host of the current party */
  isHost: boolean
  /** Pause notification to show in the video player */
  pauseNotification: PauseNotification | null
  /** Whether push-to-talk is active (user is speaking) */
  isPttActive: boolean
  /** Map of userId → isTalking for voice indicators */
  talkingMembers: Map<string, boolean>
  /** Whether the watch party room UI is visible */
  isRoomVisible: boolean
  /** Voice connection status for diagnostics */
  voiceStatus: 'idle' | 'mic-requesting' | 'mic-granted' | 'mic-denied' | 'connecting' | 'connected' | 'error'
  /** Voice error message (if any) */
  voiceError: string | null
  /**
   * The playback time at which the current party session started.
   * Unlike playbackState.currentTime (overwritten every 500ms by sync),
   * this stays fixed at the initial value so the player can detect when
   * an embed provider resumes from its own saved progress instead of
   * the party's expected start position.
   */
  partyStartTime: number

  // ── Actions ───────────────────────────────────────────

  /** Set the current party data */
  setCurrentParty: (party: WatchPartyData | null) => void
  /** Add a received invitation */
  addInvitation: (invitation: WatchPartyInvitation) => void
  /** Remove an invitation (after accept/reject/dismiss) */
  removeInvitation: (partyId: string) => void
  /** Clear all invitations */
  clearInvitations: () => void
  /** Set socket connection status */
  setConnected: (connected: boolean) => void
  /** Update members list */
  setMembers: (members: PartyMember[]) => void
  /** Update playback state */
  setPlaybackState: (state: Partial<WatchPartyData['playbackState']>) => void
  /** Update content in the party */
  setPartyContent: (data: {
    contentId: string
    mediaType: 'movie' | 'tv'
    season: number | null
    episode: number | null
    contentTitle: string
    contentPoster: string | null
  }) => void
  /** Set party status */
  setPartyStatus: (status: WatchPartyData['status']) => void
  /** Show pause notification */
  showPauseNotification: (notification: PauseNotification) => void
  /** Clear pause notification */
  clearPauseNotification: () => void
  /** Toggle push-to-talk state */
  setPttActive: (active: boolean) => void
  /** Update talking state for a member */
  setMemberTalking: (userId: string, isTalking: boolean) => void
  /** Toggle room UI visibility */
  setRoomVisible: (visible: boolean) => void
  /** Set voice connection status */
  setVoiceStatus: (status: WatchPartyState['voiceStatus'], error?: string) => void
  /** Update a member's profile data (displayName, avatarUrl) in the current party */
  updateMemberProfile: (userId: string, updates: { displayName?: string; avatarUrl?: string | null }) => void
  /** Set the party start time (fixed, not overwritten by sync) */
  setPartyStartTime: (time: number) => void
  /** Leave the current party (reset state) */
  leaveParty: () => void
  /** End the current party (host only, reset state) */
  endParty: () => void
  /** Internal: reset all party state */
  _resetParty: () => void
}

// ── Store ──────────────────────────────────────────────────

export const useWatchPartyStore = create<WatchPartyState>((set, get) => ({
  currentParty: null,
  pendingInvitations: [],
  isConnected: false,
  isInParty: false,
  isHost: false,
  pauseNotification: null,
  isPttActive: false,
  talkingMembers: new Map(),
  isRoomVisible: false,
  voiceStatus: 'idle',
  voiceError: null,
  partyStartTime: 0,

  setCurrentParty: (party) => {
    set({
      currentParty: party,
      isInParty: party !== null,
      // isHost is intentionally NOT set here — it must be computed by comparing
      // the current user's ID with party.hostId, which requires access to the
      // auth store. The hook (use-watch-party.ts) sets isHost separately via
      // useWatchPartyStore.setState({ isHost: partyData.hostId === userId })
    })
  },

  addInvitation: (invitation) => {
    set((s) => {
      // Don't add duplicates
      if (s.pendingInvitations.some((i) => i.partyId === invitation.partyId)) return s
      return { pendingInvitations: [...s.pendingInvitations, invitation] }
    })
  },

  removeInvitation: (partyId) => {
    set((s) => ({
      pendingInvitations: s.pendingInvitations.filter((i) => i.partyId !== partyId),
    }))
  },

  clearInvitations: () => set({ pendingInvitations: [] }),

  setConnected: (connected) => set({ isConnected: connected }),

  setMembers: (members) => {
    set((s) => {
      if (!s.currentParty) return s
      return {
        currentParty: { ...s.currentParty, members },
      }
    })
  },

  setPlaybackState: (playbackUpdate) => {
    set((s) => {
      if (!s.currentParty) return s
      return {
        currentParty: {
          ...s.currentParty,
          playbackState: { ...s.currentParty.playbackState, ...playbackUpdate },
        },
      }
    })
  },

  setPartyContent: (data) => {
    set((s) => {
      if (!s.currentParty) return s
      const isSameContent = s.currentParty.contentId === data.contentId
      const isPlaying = s.currentParty.status === 'playing'
      return {
        currentParty: {
          ...s.currentParty,
          contentId: data.contentId,
          mediaType: data.mediaType,
          season: data.season,
          episode: data.episode,
          contentTitle: data.contentTitle,
          contentPoster: data.contentPoster,
          // Preserve playing state when the party is already active.
          // Only reset playbackState for genuinely new content when the
          // party is NOT yet playing (e.g., host picked content but
          // hasn't pressed Start yet). This eliminates the fragile
          // "re-apply isPlaying after setPartyContent" pattern that
          // was causing race conditions between content-picked and
          // party-started broadcasts arriving in different orders.
          playbackState: (isSameContent || isPlaying)
            ? s.currentParty.playbackState
            : { isPlaying: false, currentTime: 0, duration: 0, pausedBy: null },
        },
      }
    })
  },

  setPartyStatus: (status) => {
    set((s) => {
      if (!s.currentParty) return s
      return {
        currentParty: { ...s.currentParty, status },
      }
    })
  },

  showPauseNotification: (notification) => set({ pauseNotification: notification }),
  clearPauseNotification: () => set({ pauseNotification: null }),

  setPttActive: (active) => set({ isPttActive: active }),

  setMemberTalking: (userId, isTalking) => {
    set((s) => {
      const updated = new Map(s.talkingMembers)
      if (isTalking) {
        updated.set(userId, true)
      } else {
        updated.delete(userId)
      }
      return { talkingMembers: updated }
    })
  },

  setRoomVisible: (visible) => set({ isRoomVisible: visible }),

  setVoiceStatus: (status, error) => set({ voiceStatus: status, voiceError: error ?? null }),

  updateMemberProfile: (userId, updates) => {
    set((s) => {
      if (!s.currentParty) return s
      return {
        currentParty: {
          ...s.currentParty,
          members: s.currentParty.members.map((m) =>
            m.userId === userId ? { ...m, ...updates } : m
          ),
        },
      }
    })
  },

  setPartyStartTime: (time) => set({ partyStartTime: time }),

  _resetParty: () => {
    set({
      currentParty: null,
      isInParty: false,
      isHost: false,
      pauseNotification: null,
      isPttActive: false,
      talkingMembers: new Map(),
      isRoomVisible: false,
      voiceStatus: 'idle',
      voiceError: null,
      partyStartTime: 0,
    })
  },

  leaveParty: () => {
    get()._resetParty()
  },

  endParty: () => {
    get()._resetParty()
  },
}))
