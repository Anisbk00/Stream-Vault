/**
 * StreamVault — Watch Party Realtime Hook (Supabase)
 *
 * Architecture:
 *   - Server-side API route (/api/watch-party) for ALL DB writes
 *     using the Supabase service role key (bypasses RLS)
 *   - Client-side Supabase for Realtime channels (Broadcast + Presence)
 *   - Client-side Supabase for SELECT reads (RLS allows authenticated reads)
 *   - DB poll on auth for offline invites + active party rejoin
 */

'use client'

import { useEffect, useCallback } from 'react'
import { supabase } from '@/lib/supabase'
import { useWatchPartyStore } from '@/store/watch-party'
import { useAuthStore, getAuthToken } from '@/store'
import { toast } from 'sonner'
import type { RealtimeChannel } from '@supabase/supabase-js'
import type {
  WatchPartyData,
  WatchPartyInvitation,
  PartyMember,
} from '@/lib/watch-party-types'
import {
  WebRtcVoiceManager,
  type WpWebrtcOfferEvent,
  type WpWebrtcAnswerEvent,
  type WpWebrtcIceEvent,
  type WpWebrtcEvent,
} from '@/lib/webrtc-voice'
import {
  isIOSDevice,
  VoiceClipRecorder,
  playVoiceClip,
  stopAllVoiceClips,
  encodeClipToBase64,
  initAudioContext,
  cleanupAudioContext,
  type WpVoiceClipEvent,
} from '@/lib/voice-clip'

// ── Module-level channel state ─────────────────────────────
let _invitesChannel: RealtimeChannel | null = null
let _partyChannel: RealtimeChannel | null = null
let _currentPartyId: string | null = null
let _subscribedUserId: string | null = null
let _voiceManager: WebRtcVoiceManager | null = null
let _syncInterval: ReturnType<typeof setInterval> | null = null
let _keepaliveInterval: ReturnType<typeof setInterval> | null = null
let _syncInProgress = false
let _contentHealInterval: ReturnType<typeof setInterval> | null = null
let _lastChannelRecreation = 0 // Timestamp of last channel recreation (cooldown)
let _pttHeld = false // tracks whether the user is physically holding PTT — survives async boundaries
let _clipRecorder: VoiceClipRecorder | null = null // iOS-only: records voice clips during PTT hold
let _pttStoppedUsers = new Set<string>() // userIds that sent ptt-stop; prevents presence sync from re-activating talking state. Only cleared by ptt-start or party leave.
let _talkingTimeouts = new Map<string, ReturnType<typeof setTimeout>>() // Safety timeouts for stuck speaking indicators. Cleared when ptt-stop is received.
const TALKING_TIMEOUT_MS = 10_000 // 10 seconds — auto-clear stuck speaking indicator if no ptt-stop received
/**
 * Whether the voice manager has been initialized (mic accessed).
 * On iOS/Android WebView, creating RTCPeerConnection with an audio transceiver
 * before getUserMedia switches AVAudioSession to PlayAndRecord, which suppresses
 * all other audio output (iframe video, etc.). To prevent this, we gate all
 * createOffer() calls behind this flag — no peer connections are created until
 * the user explicitly presses PTT (which calls init() first).
 */
let _voiceReady = false
let _hostLeftAt: number | null = null // Timestamp when host presence was last seen leaving
let _hostLeftTimer: ReturnType<typeof setTimeout> | null = null // Timer to auto-end party when host is gone too long
const HOST_ABSENCE_TIMEOUT_MS = 1_000 // 1 second — presence leave already has ~15-30s heartbeat tolerance
let _memberLeftTimers = new Map<string, ReturnType<typeof setTimeout>>() // Per-member absence timers (host-side)
const MEMBER_ABSENCE_TIMEOUT_MS = 30_000 // 30 seconds before removing absent member

// ── REST fallback detection ────────────────────────────────
// When the Supabase WebSocket silently dies, channel.send() falls back to
// REST without throwing. We detect this by checking if send() returns a
// thenable (Promise). If we see 3+ REST fallbacks in a 10s window, the
// WebSocket is confirmed dead and we recreate the channel.
let _restFallbackCount = 0
let _restFallbackResetTimer: ReturnType<typeof setTimeout> | null = null
const REST_FALLBACK_THRESHOLD = 3 // consecutive REST sends before recreating channel
const REST_FALLBACK_WINDOW_MS = 10_000 // time window for counting consecutive REST sends

function detectRestFallback(channel: RealtimeChannel, result: unknown): void {
  // channel.send() returns a Promise when it falls back to REST.
  // When using WebSocket, it returns undefined or a non-thenable.
  if (result && typeof result === 'object' && 'then' in result) {
    _restFallbackCount++
    if (_restFallbackResetTimer) clearTimeout(_restFallbackResetTimer)
    _restFallbackResetTimer = setTimeout(() => {
      _restFallbackCount = 0
    }, REST_FALLBACK_WINDOW_MS)

    if (_restFallbackCount >= REST_FALLBACK_THRESHOLD) {
      _restFallbackCount = 0
      if (_restFallbackResetTimer) clearTimeout(_restFallbackResetTimer)
      // WebSocket is dead — recreate the channel to restore WS connection
      if (channel === _partyChannel) {
        console.warn('[WatchParty] Detected sustained REST fallback — recreating party channel')
        recreatePartyChannel()
      } else if (channel === _invitesChannel) {
        console.warn('[WatchParty] Detected sustained REST fallback — recreating invites channel')
        recreateInvitesChannel()
      }
    }
  } else {
    // send() used WebSocket — reset counter
    _restFallbackCount = 0
    if (_restFallbackResetTimer) clearTimeout(_restFallbackResetTimer)
  }
}

/** Clear the safety timeout for a talking indicator (called when ptt-stop is received). */
function clearTalkingTimeout(userId: string): void {
  const existing = _talkingTimeouts.get(userId)
  if (existing) {
    clearTimeout(existing)
    _talkingTimeouts.delete(userId)
  }
}

// ── Broadcast helper with error handling ────────────────────
// Centralizes all Supabase Realtime broadcast sends with:
//   - Always tries WebSocket first (fast, real-time)
//   - Falls back to httpSend() for that specific message when WebSocket is down
//   - Schedules channel resubscribe to recover WebSocket connection
//
// IMPORTANT: We do NOT track a global "WebSocket connected" flag.
// The old approach had a shared _wsConnected flag that, once set to false
// by ANY channel's disconnect, permanently disabled WebSocket sends for
// ALL channels. This caused a cascade failure: one channel's WebSocket
// drop → all channels fall back to REST → WebRTC signaling becomes
// unreliable → ICE negotiation fails → no voice + no PTT indicators.

// Track channels that are pending resubscription to avoid duplicate attempts
const _resubscribePending = new WeakSet<RealtimeChannel>()

function wpBroadcast(
  channel: RealtimeChannel | null,
  payload: WpBroadcastEvent,
  label: string,
): void {
  if (!channel) {
    console.warn(`[WatchParty] Broadcast skipped (${label}): no channel`)
    return
  }

  try {
    const result = channel.send({
      type: 'broadcast',
      event: 'wp',
      payload,
    })
    // Detect if send() fell back to REST (returns a Promise when REST,
    // undefined/thenable when WebSocket). If sustained REST detected,
    // recreate the channel to restore WebSocket connectivity.
    detectRestFallback(channel, result)
    return
  } catch {
    // send() threw — WebSocket is likely down, try httpSend as fallback
    try {
      channel.httpSend('wp', payload).then((res: { success: boolean; error?: string }) => {
        if (res.success === false) {
          console.error(`[WatchParty] httpSend failed (${label}):`, res.error)
        }
      }).catch((err: Error) => {
        console.error(`[WatchParty] httpSend error (${label}):`, err.message)
      })
      // Schedule resubscribe since send() threw (WebSocket definitely down)
      scheduleChannelResubscribe(channel)
    } catch {
      // Completely failed — nothing more we can do
    }
  }
}

/** Schedule a channel resubscribe to recover the WebSocket connection. */
function scheduleChannelResubscribe(channel: RealtimeChannel): void {
  if (_resubscribePending.has(channel)) return
  _resubscribePending.add(channel)

  // Wait 2 seconds before resubscribing to avoid hammering the server
  // if multiple broadcasts fail in quick succession (e.g., ICE candidates)
  setTimeout(() => {
    _resubscribePending.delete(channel)
    const state = channel.state
    // Supabase Realtime uses 'joined' for the subscribed state.
    // Valid states: 'closed', 'closing', 'joined', 'joining', 'leaving', 'timed_out'
    if (state === 'joined') return

    // CRITICAL: channel.subscribe() can only be called ONCE per channel
    // instance. If the channel state is 'closed' or 'timed_out', the
    // underlying WebSocket is dead and subscribe() will throw
    // 'tried to join multiple times'. The only fix is to create a
    // brand-new channel instance.
    if (channel === _partyChannel) {
      console.log('[WatchParty] Party channel dead (state:', state, ') — recreating channel')
      recreatePartyChannel()
    } else if (channel === _invitesChannel) {
      console.log('[WatchParty] Invites channel dead (state:', state, ') — recreating channel')
      recreateInvitesChannel()
    }
  }, 2000)
}

/**
 * Recreate the party channel when the WebSocket dies.
 * Supabase Realtime's subscribe() can only be called once per channel instance.
 * When the channel reaches 'closed' or 'timed_out', the only option is
 * to create a fresh channel. This preserves the voice manager and peer
 * connections — only the signaling transport is replaced.
 */
function recreatePartyChannel(): void {
  if (!_currentPartyId) return
  // Cooldown: don't recreate more than once every 10 seconds.
  // Cascading recreations (REST fallback → recreate → fail → recreate)
  // were causing a 429 rate limit storm on the API.
  const now = Date.now()
  if (now - _lastChannelRecreation < 10_000) return
  _lastChannelRecreation = now

  const partyId = _currentPartyId
  const userId = useAuthStore.getState().user?.id
  if (!userId) return
  const profile = useAuthStore.getState().profile

  // Preserve the voice manager across channel recreation.
  // unsubscribePartyChannel destroys the voice manager, but during
  // a recreation we only need a new signaling transport — the
  // existing WebRTC peer connections should survive. Destroying
  // them mid-PTT causes NPE crashes and permanent voice loss.
  const savedVoiceManager = _voiceManager
  const savedVoiceReady = _voiceReady

  // Remove dead channel so subscribePartyChannel doesn't early-return.
  _partyChannel = null
  // Temporarily null the voice manager so unsubscribePartyChannel skips it
  _voiceManager = null
  _voiceReady = false

  subscribePartyChannel(partyId, userId, profile?.display_name || 'Unknown', profile?.avatar_url || null)

  // subscribePartyChannel creates a new voice manager because _voiceManager
  // was null. But we want to KEEP the existing one (with its established
  // peer connections). Restore the saved manager and destroy the new one.
  if (savedVoiceManager) {
    if (_voiceManager && _voiceManager !== savedVoiceManager) {
      // A new manager was created — destroy it and restore the saved one
      _voiceManager.destroy()
    }
    _voiceManager = savedVoiceManager
    _voiceReady = savedVoiceReady
    // Update signal sender to use the new channel
    if (_partyChannel) {
      _voiceManager.setSignalSender((targetUserId, signal) => {
        if (!_partyChannel) return
        let payload: WpWebrtcEvent
        switch (signal.type) {
          case 'offer':
            payload = { t: 'webrtc-offer', targetUserId, fromUserId: userId, sdp: signal.sdp! }
            break
          case 'answer':
            payload = { t: 'webrtc-answer', targetUserId, fromUserId: userId, sdp: signal.sdp! }
            break
          case 'ice-candidate':
            payload = { t: 'webrtc-ice', targetUserId, fromUserId: userId, candidate: signal.candidate! }
            break
        }
        wpBroadcast(_partyChannel!, payload, `webrtc-${payload.t}`)
      })
    }
    console.log('[WatchParty] Preserved voice manager across channel recreation')
  }
}

/** Recreate the invites channel when the WebSocket dies. */
function recreateInvitesChannel(): void {
  const userId = _subscribedUserId
  if (!userId) return
  _invitesChannel = null
  _subscribedUserId = null
  subscribeInvitesChannel(userId)
}


// ── Broadcast event types ──────────────────────────────────

interface WpInviteEvent {
  t: 'invite'
  partyId: string
  hostId: string
  hostName: string
  hostAvatarUrl: string | null
  memberCount: number
  targetUserId: string
}

interface WpInviteRejectedEvent {
  t: 'invite-rejected'
  partyId: string
  userId: string
  displayName: string
  targetUserId: string
}

interface WpMemberJoinedEvent {
  t: 'member-joined'
  member: PartyMember
}

interface WpMemberLeftEvent {
  t: 'member-left'
  userId: string
  displayName: string
}

interface WpContentPickedEvent {
  t: 'content-picked'
  contentId: string
  mediaType: 'movie' | 'tv'
  season: number | null
  episode: number | null
  contentTitle: string
  contentPoster: string | null
}

interface WpPartyStartedEvent {
  t: 'party-started'
  currentTime: number
  contentId?: string
  mediaType?: 'movie' | 'tv'
  season?: number | null
  episode?: number | null
  contentTitle?: string
  contentPoster?: string | null
}

interface WpPausedEvent {
  t: 'paused'
  pausedBy: string
  pausedByName: string
  currentTime: number
}

interface WpPlayedEvent {
  t: 'played'
  currentTime: number
  resumedBy: string
  resumedByName: string
}

interface WpSeekedEvent {
  t: 'seeked'
  currentTime: number
  seekedBy: string
  seekedByName: string
}

interface WpEndedEvent {
  t: 'ended'
  endedBy: string
}

interface WpSyncEvent {
  t: 'sync'
  currentTime: number
  isPlaying: boolean
  /** Timestamp (ms) when the host sent this sync — allows members to calculate one-way latency */
  sentAt: number
}

interface WpPttStartEvent {
  t: 'ptt-start'
  userId: string
  displayName: string
}

interface WpPttStopEvent {
  t: 'ptt-stop'
  userId: string
}

interface WpProfileUpdatedEvent {
  t: 'profile-updated'
  userId: string
  displayName: string
  avatarUrl: string | null
}

type WpBroadcastEvent =
  | WpInviteEvent
  | WpInviteRejectedEvent
  | WpMemberJoinedEvent
  | WpMemberLeftEvent
  | WpContentPickedEvent
  | WpPartyStartedEvent
  | WpPausedEvent
  | WpPlayedEvent
  | WpSeekedEvent
  | WpEndedEvent
  | WpSyncEvent
  | WpPttStartEvent
  | WpPttStopEvent
  | WpProfileUpdatedEvent
  | WpWebrtcOfferEvent
  | WpWebrtcAnswerEvent
  | WpWebrtcIceEvent

// ── API helper ─────────────────────────────────────────────

async function wpApi(
  action: string,
  payload: Record<string, unknown> = {},
): Promise<{ ok: boolean; data: Record<string, unknown>; error?: string }> {
  const token = await getAuthToken()
  if (!token) {
    return { ok: false, data: {}, error: 'Not authenticated' }
  }

  try {
    const res = await fetch('/api/watch-party', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ action, ...payload }),
    })

    const json = await res.json()

    if (!res.ok) {
      console.error(`[WatchParty] API error (${res.status}):`, json.error || 'Unknown error')
      return { ok: false, data: {}, error: json.error || `Request failed (${res.status})` }
    }

    return { ok: true, data: json }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Network error'
    console.error('[WatchParty] API network error:', message)
    return { ok: false, data: {}, error: message }
  }
}

// ── Sync debounce — prevents DB write flood ────────────────
// sendSync fires every 500ms (host broadcasts time to members).
// The DB write (for rejoin recovery) doesn't need that frequency.
// Debounce to at most once per 5 seconds.
let _lastSyncDbWrite = 0
const SYNC_DB_DEBOUNCE_MS = 5_000

/** Most recent sync broadcast's sentAt timestamp (ms) — used by members for latency compensation */
let _lastSyncSentAt = 0

function debouncedSyncToDb(partyId: string, currentTime: number, isPlaying: boolean): void {
  const now = Date.now()
  if (now - _lastSyncDbWrite < SYNC_DB_DEBOUNCE_MS) return
  _lastSyncDbWrite = now
  wpApi('sync', { partyId, currentTime, isPlaying }).catch(() => { /* non-critical */ })
}

// ── DB helpers (SELECT only — RLS allows these) ────────────

async function fetchPartyFromDb(partyId: string): Promise<WatchPartyData | null> {
  try {
    const { data: party, error } = await supabase
      .from('watch_parties')
      .select('*')
      .eq('id', partyId)
      .maybeSingle()

    if (error || !party) return null

    const { data: memberRows } = await supabase
      .from('watch_party_members')
      .select('user_id, status')
      .eq('party_id', partyId)
      .in('status', ['joined', 'invited'])

    const memberUserIds = (memberRows || []).map((m) => m.user_id)
    const memberStatusMap = new Map((memberRows || []).map((m) => [m.user_id, m.status]))

    const { data: profiles } = await supabase
      .from('profiles')
      .select('id, display_name, avatar_url')
      .in('id', memberUserIds.length > 0 ? memberUserIds : ['__none__'])

    const profileMap = new Map((profiles || []).map((p) => [p.id, p]))

    const partyMembers: PartyMember[] = memberUserIds.map((uid) => {
      const profile = profileMap.get(uid)
      return {
        userId: uid,
        displayName: profile?.display_name || 'Unknown',
        avatarUrl: profile?.avatar_url || null,
        isHost: uid === party.host_id,
        isTalking: false,
        memberStatus: (memberStatusMap.get(uid) as 'joined' | 'invited') || 'joined' as const,
      }
    })

    return {
      id: party.id,
      hostId: party.host_id,
      contentId: party.content_id,
      mediaType: party.media_type as 'movie' | 'tv' | null,
      season: party.season,
      episode: party.episode,
      contentTitle: party.content_title,
      contentPoster: party.content_poster,
      status: party.status as 'waiting' | 'playing' | 'ended',
      members: partyMembers,
      playbackState: {
        isPlaying: party.is_playing,
        currentTime: party.playback_time || 0,
        duration: 0,
        pausedBy: party.paused_by,
      },
      createdAt: new Date(party.created_at).getTime(),
    }
  } catch {
    return null
  }
}

async function fetchPendingInvites(userId: string): Promise<WatchPartyInvitation[]> {
  try {
    const { data: memberRows } = await supabase
      .from('watch_party_members')
      .select('party_id')
      .eq('user_id', userId)
      .eq('status', 'invited')

    if (!memberRows || memberRows.length === 0) return []

    const invitations: WatchPartyInvitation[] = []
    for (const row of memberRows) {
      const party = await fetchPartyFromDb(row.party_id)
      if (!party || party.status === 'ended') continue

      const hostMember = party.members.find((m) => m.isHost)
      invitations.push({
        partyId: row.party_id,
        hostId: party.hostId,
        hostName: hostMember?.displayName || 'Unknown',
        hostAvatarUrl: hostMember?.avatarUrl || null,
        memberCount: party.members.length,
        receivedAt: Date.now(),
      })
    }
    return invitations
  } catch {
    return []
  }
}

async function checkActiveParty(userId: string) {
  try {
    // Guard: if already in a party with an active channel, don't overwrite state.
    // This prevents auth token refreshes from destroying the current party session.
    const currentStore = useWatchPartyStore.getState()
    if (currentStore.isInParty && _partyChannel && _currentPartyId) {
      return
    }

    const { data: memberRows } = await supabase
      .from('watch_party_members')
      .select('party_id')
      .eq('user_id', userId)
      .eq('status', 'joined')
      .order('joined_at', { ascending: false })
      .limit(1)

    if (!memberRows || memberRows.length === 0) return

    const partyId = memberRows[0].party_id
    const partyData = await fetchPartyFromDb(partyId)

    if (!partyData || partyData.status === 'ended') {
      // Clean up stale membership via API
      await wpApi('leave', { partyId })
      return
    }

    const store = useWatchPartyStore.getState()
    store.setCurrentParty(partyData)
    useWatchPartyStore.setState({
      isHost: partyData.hostId === userId,
      isRoomVisible: true,
      partyStartTime: partyData.playbackState.currentTime,
    })

    const profile = useAuthStore.getState().profile
    subscribePartyChannel(partyId, userId, profile?.display_name || 'Unknown', profile?.avatar_url || null)
  } catch {
    // Silent — don't block app load
  }
}

// ── Channel management ─────────────────────────────────────

function subscribeInvitesChannel(userId: string) {
  if (_invitesChannel && _subscribedUserId === userId) return

  unsubscribeInvitesChannel()

  _subscribedUserId = userId

  try {
    // Per-user invite channel — each user only receives their own invites.
    // Previous design used a shared 'wp-invites' channel where ALL users
    // received ALL invite payloads (privacy leak). Now each user subscribes
    // to their own channel, so they only see invites targeting them.
    _invitesChannel = supabase.channel(`wp-invites-${userId}`, {
      config: { broadcast: { self: false } },
    })

    _invitesChannel.on('broadcast', { event: 'wp' }, (payload: { payload: WpBroadcastEvent }) => {
      const event = payload.payload
      const store = useWatchPartyStore.getState()

      if (event.t === 'invite') {
        // Double-check targetUserId matches (defense in depth)
        if (event.targetUserId === userId) {
          store.addInvitation({
            partyId: event.partyId,
            hostId: event.hostId,
            hostName: event.hostName,
            hostAvatarUrl: event.hostAvatarUrl,
            memberCount: event.memberCount,
            receivedAt: Date.now(),
          })
        }
      }

      if (event.t === 'invite-rejected') {
        if (event.targetUserId === userId) {
          toast.info(`${event.displayName} declined your watch party invitation`)
          store.removeInvitation(event.partyId)
        }
      }
    })

    _invitesChannel.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        console.log('[WatchParty] Invites channel subscribed successfully')
        _restFallbackCount = 0
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSE') {
        console.error('[WatchParty] Invites channel disconnected:', status)
        // Retry after 5 seconds — must recreate the channel since
        // subscribe() can only be called once per instance
        setTimeout(() => {
          if (_invitesChannel) {
            console.log('[WatchParty] Invites channel dead — recreating')
            recreateInvitesChannel()
          }
        }, 5000)
      }
    })
  } catch (err) {
    console.error('[WatchParty] Invites channel creation failed:', err instanceof Error ? err.message : err)
    _invitesChannel = null
    _subscribedUserId = null
  }
}

function unsubscribeInvitesChannel() {
  if (_invitesChannel) {
    try { supabase.removeChannel(_invitesChannel) } catch { /* already removed */ }
    _invitesChannel = null
  }
  _subscribedUserId = null
}

function subscribePartyChannel(
  partyId: string,
  userId: string,
  displayName: string,
  avatarUrl: string | null,
  onSubscribed?: () => void,
) {
  if (_partyChannel && _currentPartyId === partyId) return

  unsubscribePartyChannel()

  _currentPartyId = partyId

  try {
    _partyChannel = supabase.channel(`wp-party-${partyId}`, {
      config: {
        broadcast: { self: false },
        presence: { key: userId },
      },
    })

    // ── Eagerly create voice manager BEFORE subscription ─────
    // Previously the voice manager was only created inside the
    // subscribe() callback when status === 'SUBSCRIBED'. If the
    // Supabase Realtime WebSocket is stuck in CONNECTING (which
    // happens when it falls back to REST for sends), the callback
    // never fires and _voiceManager stays null forever — causing
    // "Voice manager not available" on every PTT press.
    // Creating it eagerly ensures it's available immediately.
    //
    // On iOS, we do NOT create a WebRTC voice manager — iOS uses
    // voice clip recording instead. PeerConnections on iOS keep
    // AVAudioSession in .playAndRecord mode, permanently ducking
    // movie audio even after track.stop().
    if (!isIOSDevice() && !_voiceManager) {
      _voiceManager = new WebRtcVoiceManager(userId)
      console.log('[WatchParty] WebRTC voice manager created eagerly for user', userId)

      // Wire signal sender to Supabase broadcast (captures _partyChannel by reference)
      _voiceManager.setSignalSender((targetUserId, signal) => {
        if (!_partyChannel) return
        let payload: WpWebrtcEvent
        switch (signal.type) {
          case 'offer':
            payload = { t: 'webrtc-offer', targetUserId, fromUserId: userId, sdp: signal.sdp! }
            break
          case 'answer':
            payload = { t: 'webrtc-answer', targetUserId, fromUserId: userId, sdp: signal.sdp! }
            break
          case 'ice-candidate':
            payload = { t: 'webrtc-ice', targetUserId, fromUserId: userId, candidate: signal.candidate! }
            break
        }
        wpBroadcast(_partyChannel, payload, `webrtc-${payload.t}`)
      })

      // Auto-play remote audio (manager handles HTMLAudioElement internally)
      _voiceManager.setOnRemoteStream((remoteUserId, _stream) => {
        console.log('[WatchParty] Remote stream received from', remoteUserId)
        _voiceManager?.retryPausedAudio()
      })

      _voiceManager.setOnRemoteStreamRemoved((remoteUserId) => {
        useWatchPartyStore.getState().setMemberTalking(remoteUserId, false)
      })

      // Mic init is DEFERRED to first PTT press (sendPttStart) to avoid
      // altering the OS audio session before the iframe video player loads.
      // On iOS/Android, getUserMedia switches AVAudioSession from Playback
      // to PlayAndRecord which suppresses iframe audio output entirely.
      // On desktop, it may lower output volume to prevent acoustic feedback.
      // The voice manager OBJECT is still created eagerly here so that
      // incoming WebRTC signals can be handled immediately.
    }

    // ── Broadcast events ────────────────────────────────────
    _partyChannel.on('broadcast', { event: 'wp' }, (payload: { payload: WpBroadcastEvent }) => {
      const event = payload.payload
      const store = useWatchPartyStore.getState()

      switch (event.t) {
        case 'member-joined':
          if (store.currentParty) {
            const existing = store.currentParty.members.find((m) => m.userId === event.member.userId)
            if (existing) {
              // Update existing member's status from 'invited' → 'joined'
              store.setMembers(
                store.currentParty.members.map((m) =>
                  m.userId === event.member.userId ? { ...m, ...event.member, memberStatus: event.member.memberStatus || 'joined' } : m
                )
              )
              console.log(`[WatchParty] Member ${event.member.displayName} status updated to '${event.member.memberStatus || 'joined'}'`)
            } else {
              store.setMembers([...store.currentParty.members, event.member])
              console.log(`[WatchParty] New member ${event.member.displayName} added with status '${event.member.memberStatus || 'joined'}'`)
            }
            toast.success(`${event.member.displayName} joined the watch party`)

            // NOTE: We intentionally do NOT refresh members from DB here.
            // The broadcast carries the authoritative member status ('joined').
            // A DB refresh at this point races with the accept API write
            // and can overwrite the correct 'joined' status with stale 'invited'
            // data from a read that occurred before the DB transaction committed.
            // The 30-second periodic sync handles any missed updates.

            // Re-broadcast current content to the new member.
            // If the host picked content before the member subscribed,
            // the member missed the content-picked broadcast and their
            // panel would stay on "Waiting for host to pick content...".
            // The content-picked handler on the member side only shows
            // a toast if the content actually changed, so existing
            // members won't see duplicate toasts.
            if (event.member.userId !== userId && store.currentParty.contentId && _partyChannel) {
              wpBroadcast(_partyChannel, {
                  t: 'content-picked',
                  contentId: store.currentParty.contentId,
                  mediaType: store.currentParty.mediaType!,
                  season: store.currentParty.season,
                  episode: store.currentParty.episode,
                  contentTitle: store.currentParty.contentTitle!,
                  contentPoster: store.currentParty.contentPoster,
                } as WpContentPickedEvent, 'content-rebroadcast')
              console.log(`[WatchParty] Re-broadcast content-picked to new member ${event.member.displayName}`)
            }

            // Also re-broadcast current playback state (playing/paused) so the
            // new member knows whether the content is currently playing.
            if (event.member.userId !== userId && _partyChannel && store.currentParty.status === 'playing') {
              const ps = store.currentParty.playbackState
              if (ps.isPlaying) {
                wpBroadcast(_partyChannel, {
                    t: 'played',
                    currentTime: ps.currentTime,
                    resumedBy: store.currentParty.hostId,
                    resumedByName: 'Host',
                  } as WpPlayedEvent, 'played-rebroadcast')
              }
            }

            // Create WebRTC voice offer for the new member
            // (existing members initiate connections to the joiner)
            // Deferred until voice is initialized (first PTT press) to
            // prevent RTCPeerConnection from switching AVAudioSession on
            // iOS/Android WebView, which suppresses iframe video audio.
            if (event.member.userId !== userId && _voiceReady) {
              _voiceManager?.createOffer(event.member.userId).catch((err) => {
                console.warn('[WatchParty] WebRTC offer creation failed for', event.member.displayName, err)
              })
            }
          }
          break

        case 'member-left':
          // SECURITY: Only accept member-left for the sender themselves, or from the host.
          // Prevents a member from forging a "member-left" to kick another user.
          if (store.currentParty && event.userId !== event.leftBy &&
              event.leftBy !== store.currentParty.hostId) {
            console.warn('[WatchParty] Rejected forged "member-left" broadcast — sender', event.leftBy, 'tried to remove', event.userId)
            break
          }
          if (store.currentParty) {
            store.setMembers(store.currentParty.members.filter((m) => m.userId !== event.userId))
            toast.info(`${event.displayName} left the watch party`)
            // Clean up WebRTC peer connection for the departing member
            _voiceManager?.removePeer(event.userId)
          }
          break

        case 'content-picked':
          // Only show toast if content actually changed (prevents duplicate
          // toasts when host re-broadcasts content for a new member)
          const isContentChange = store.currentParty?.contentId !== event.contentId
          // Preserve the playing state if the party is already playing.
          // When the host changes content mid-party, the content-picked
          // broadcast should NOT reset isPlaying — the party is still active.
          const wasPlaying = store.currentParty?.playbackState.isPlaying ?? false
          const wasStatus = store.currentParty?.status ?? 'waiting'
          store.setPartyContent({
            contentId: event.contentId,
            mediaType: event.mediaType,
            season: event.season,
            episode: event.episode,
            contentTitle: event.contentTitle,
            contentPoster: event.contentPoster,
          })
          // setPartyContent resets playbackState when contentId changes.
          // Re-apply playing state if the party was active — use current
          // status from the store (not the snapshot) because party-started
          // may have set status='playing' just before this handler runs.
          if (isContentChange) {
            const currentState = useWatchPartyStore.getState()
            if (currentState.currentParty?.status === 'playing') {
              currentState.setPlaybackState({ isPlaying: true, currentTime: 0, pausedBy: null })
              currentState.setPartyStartTime(0)
            }
          }
          if (isContentChange) {
            toast.success(`Now watching: ${event.contentTitle}`)
          }
          break

        case 'party-started':
          store.setPartyStatus('playing')
          store.setPlaybackState({ isPlaying: true, currentTime: event.currentTime, pausedBy: null })
          store.setPartyStartTime(event.currentTime)
          console.log('[WatchParty] Party started at time', event.currentTime)
          // Always apply content from the broadcast — even if we already
          // have content (it may be stale from a previous pick, or the
          // host changed content before starting). This guarantees
          // members always see the correct content.
          if (event.contentId) {
            const contentChanged = store.currentParty?.contentId !== event.contentId
            store.setPartyContent({
              contentId: event.contentId,
              mediaType: event.mediaType ?? 'movie',
              season: event.season ?? null,
              episode: event.episode ?? null,
              contentTitle: event.contentTitle ?? '',
              contentPoster: event.contentPoster ?? null,
            })
            // setPartyContent resets playbackState when content changes,
            // so re-apply playing state.
            store.setPlaybackState({ isPlaying: true, currentTime: event.currentTime, pausedBy: null })
            if (contentChanged) {
              console.log('[WatchParty] Content updated from party-started broadcast:', event.contentTitle)
            }
          }
          break

        case 'paused':
          // SECURITY: Verify sender is a known member of this party.
          // Prevents forged pause broadcasts from non-members who
          // discover the channel name.
          if (store.currentParty && !store.currentParty.members.some((m) => m.userId === event.pausedBy)) {
            console.warn('[WatchParty] Rejected forged "paused" broadcast from non-member:', event.pausedBy)
            break
          }
          store.setPlaybackState({ isPlaying: false, pausedBy: event.pausedBy, currentTime: event.currentTime })
          store.showPauseNotification({ pausedByName: event.pausedByName, currentTime: event.currentTime })
          break

        case 'played':
          store.setPlaybackState({ isPlaying: true, pausedBy: null, currentTime: event.currentTime })
          store.clearPauseNotification()
          break

        case 'seeked':
          store.setPlaybackState({ currentTime: event.currentTime })
          break

        case 'sync':
          // Host periodic sync — members use this to correct drift
          store.setPlaybackState({
            currentTime: event.currentTime,
            isPlaying: event.isPlaying,
          })
          if (event.sentAt) _lastSyncSentAt = event.sentAt
          break

        case 'ptt-start':
          if (event.userId && event.userId !== userId) {
            // Remove from stopped set — they're talking again, so presence
            // sync data for this user is now authoritative
            _pttStoppedUsers.delete(event.userId)
            store.setMemberTalking(event.userId, true)
            console.log('[WatchParty] PTT start from', event.displayName)
            // Retry any paused remote audio elements when a remote
            // user starts talking. The browser autoplay policy blocks
            // audio.play() without a user gesture, but the PTT button
            // press on the remote side means audio should start flowing.
            // We retry here as a best-effort — if still blocked, the
            // next local PTT press (a real user gesture) will unlock it.
            _voiceManager?.retryPausedAudio()
            // Safety timeout: auto-clear the talking indicator if no ptt-stop
            // is received within TALKING_TIMEOUT_MS. This prevents the indicator
            // from getting permanently stuck when ptt-stop broadcasts are lost
            // (Supabase Broadcast is fire-and-forget, not guaranteed delivery).
            clearTalkingTimeout(event.userId)
            _talkingTimeouts.set(event.userId, setTimeout(() => {
              console.warn('[WatchParty] Talking timeout for', event.userId, '— auto-clearing stuck indicator')
              store.setMemberTalking(event.userId, false)
              _pttStoppedUsers.add(event.userId)
              _talkingTimeouts.delete(event.userId)
            }, TALKING_TIMEOUT_MS))
          }
          break

        case 'ptt-stop':
          if (event.userId) {
            store.setMemberTalking(event.userId, false)
            // Mark this user as having explicitly stopped PTT.
            // Presence sync data for this user is now stale (may still
            // show isTalking: true) and must NOT re-activate the
            // talking indicator. Only a new ptt-start broadcast clears
            // this flag. This prevents the "stuck speaking" bug caused
            // by presence sync lagging behind the ptt-stop broadcast.
            _pttStoppedUsers.add(event.userId)
            // Clear the safety timeout since we received an explicit ptt-stop
            clearTalkingTimeout(event.userId)
            console.log('[WatchParty] PTT stop from', event.userId)
          }
          break

        case 'profile-updated':
          // A party member changed their display name or avatar.
          // Update the member entry in the current party so the UI
          // reflects the change instantly in the members list.
          if (store.currentParty) {
            store.updateMemberProfile(event.userId, {
              displayName: event.displayName,
              avatarUrl: event.avatarUrl,
            })
          }
          break

        case 'ended':
          // SECURITY: Verify the sender is the host. Any party member could
          // forge an 'ended' broadcast. Cross-check with the known host ID.
          if (event.endedBy && store.currentParty && event.endedBy !== store.currentParty.hostId) {
            console.warn('[WatchParty] Rejected forged "ended" broadcast from non-host:', event.endedBy)
            break
          }
          console.log('[WatchParty] Party ended by', event.endedBy)
          toast.info('Watch party has ended')
          // Clean up: leave party, unsubscribe channel, close panel
          store.leaveParty()
          unsubscribePartyChannel()
          break

        // ── WebRTC voice signaling (non-iOS only) ────────────
        // On iOS, voice uses clip recording instead of WebRTC.
        // PeerConnections are never created on iOS, so we skip
        // all WebRTC signaling to avoid triggering AVAudioSession changes.
        case 'webrtc-offer':
          if (!isIOSDevice() && event.targetUserId === userId && _voiceReady) {
            _voiceManager?.handleOffer(event.fromUserId, event.sdp)
          }
          break

        case 'webrtc-answer':
          if (!isIOSDevice() && event.targetUserId === userId && _voiceReady) {
            _voiceManager?.handleAnswer(event.fromUserId, event.sdp)
          }
          break

        case 'webrtc-ice':
          if (!isIOSDevice() && event.targetUserId === userId && _voiceReady) {
            _voiceManager?.handleIceCandidate(event.fromUserId, event.candidate)
          }
          break

        // ── Voice clip (iOS sends, all platforms receive) ──
        case 'voice-clip': {
          const clipEvent = event as unknown as WpVoiceClipEvent
          if (clipEvent.fromUserId && clipEvent.fromUserId !== userId) {
            // Show speaking indicator for the duration of the clip
            store.setMemberTalking(clipEvent.fromUserId, true)
            playVoiceClip(
              clipEvent.fromUserId,
              clipEvent.audio,
              clipEvent.mimeType,
              () => {
                // Clear speaking indicator when clip finishes playing
                store.setMemberTalking(clipEvent.fromUserId, false)
              },
            )
          }
          break
        }
      }
    })

    // ── Presence events ─────────────────────────────────────
    _partyChannel.on('presence', { event: 'sync' }, () => {
      if (!_partyChannel) return
      const store = useWatchPartyStore.getState()
      const newState = _partyChannel.presenceState()

      // Build talking map from presence, but EXCLUDE the local user.
      // The local user's talking state is managed by isPttActive,
      // not talkingMembers. Including it here causes the wrong
      // member to show as speaking when the local user presses PTT.
      const talkingMap = new Map<string, boolean>()
      Object.values(newState).forEach((presences) => {
        presences.forEach((p) => {
          const pData = p as unknown as { userId: string; isTalking: boolean }
          if (pData.isTalking && pData.userId !== userId) {
            talkingMap.set(pData.userId, true)
          }
        })
      })

      const currentTalking = store.talkingMembers
      talkingMap.forEach((_, uid) => {
        // Skip if this user explicitly stopped PTT — the presence data
        // is stale (isTalking: true) but the ptt-stop broadcast already
        // cleared the indicator. Only a new ptt-start broadcast can
        // re-activate the talking indicator for this user.
        if (_pttStoppedUsers.has(uid)) return
        if (!currentTalking.has(uid)) store.setMemberTalking(uid, true)
      })
      currentTalking.forEach((_, uid) => {
        if (!talkingMap.has(uid) && uid !== userId) store.setMemberTalking(uid, false)
      })
    })

    _partyChannel.on('presence', { event: 'leave' }, (payload: { leftPresences: { userId: string }[] }) => {
      const store = useWatchPartyStore.getState()
      const myUserId = useAuthStore.getState().user?.id

      payload.leftPresences.forEach((p) => {
        store.setMemberTalking(p.userId, false)
        _pttStoppedUsers.delete(p.userId)

        if (store.currentParty?.playbackState.pausedBy === p.userId) {
          store.setPlaybackState({ pausedBy: null })
          store.clearPauseNotification()
          toast.info('Pause released: pauser left')
        }

        // If the HOST left presence, start a 30-second timer.
        // If the host doesn't rejoin within 30s, the party auto-ends.
        // This handles: host closed app, killed process, lost connection
        // for extended period. It does NOT fire on brief network blips
        // because the host's presence will rejoin within a few seconds.
        if (
          p.userId !== myUserId &&
          store.currentParty?.hostId === p.userId &&
          !store.isHost
        ) {
          if (_hostLeftTimer) clearTimeout(_hostLeftTimer)
          _hostLeftAt = Date.now()
          _hostLeftTimer = setTimeout(() => {
            // Host still absent after 30s — auto-end for members
            const current = useWatchPartyStore.getState()
            if (!current.currentParty || !current.isInParty) return
            // Double-check: host presence might have rejoined
            const presence = _partyChannel?.presenceState()
            const hostPresent = presence && Object.values(presence).some((presences) =>
              presences.some((pr) => (pr as unknown as { userId: string }).userId === p.userId)
            )
            if (hostPresent) {
              _hostLeftAt = null
              return
            }
            console.log('[WatchParty] Host absent for 1s — auto-ending party for members')
            toast.info('Host disconnected — watch party ended')
            current.leaveParty()
            unsubscribePartyChannel()
            _hostLeftAt = null
          }, HOST_ABSENCE_TIMEOUT_MS)
        }

        // If a MEMBER left presence and we're the host, start a timer
        // to remove them from the party after 30 seconds of absence.
        // This handles: member closed app, killed process, lost connection.
        // Presence already has ~30s built-in tolerance from Supabase heartbeat,
        // so by the time this event fires, the member has been gone ~60s total.
        if (
          p.userId !== myUserId &&
          store.isHost &&
          store.currentParty?.hostId === myUserId &&
          p.userId !== store.currentParty?.hostId
        ) {
          // Cancel any existing timer for this member
          const existingTimer = _memberLeftTimers.get(p.userId)
          if (existingTimer) clearTimeout(existingTimer)

          const absentUserId = p.userId
          _memberLeftTimers.set(absentUserId, setTimeout(async () => {
            const current = useWatchPartyStore.getState()
            if (!current.currentParty || !current.isInParty || !current.isHost) return
            // Double-check: member presence might have rejoined
            const presence = _partyChannel?.presenceState()
            const memberPresent = presence && Object.values(presence).some((presences) =>
              presences.some((pr) => (pr as unknown as { userId: string }).userId === absentUserId)
            )
            if (memberPresent) {
              _memberLeftTimers.delete(absentUserId)
              return
            }
            // Member absent for 30s after presence leave — remove from party
            console.log('[WatchParty] Member', absentUserId, 'absent for 30s — removing from party')
            const partyId = _currentPartyId
            // Remove from local member list
            current.setMembers(current.currentParty.members.filter((m) => m.userId !== absentUserId))
            // Clean up WebRTC peer connection
            _voiceManager?.removePeer(absentUserId)
            // Notify other members via broadcast
            const absentMember = current.currentParty.members.find((m) => m.userId === absentUserId)
            if (absentMember && _partyChannel) {
              wpBroadcast(_partyChannel, {
                t: 'member-left',
                userId: absentUserId,
                displayName: absentMember.displayName,
              } as WpMemberLeftEvent, 'member-absence-removal')
            }
            // Update DB: set member status to 'left'
            if (partyId) {
              wpApi('remove-member', { partyId, targetUserId: absentUserId }).catch(() => { /* non-critical */ })
            }
            toast.info('A member disconnected from the watch party')
            _memberLeftTimers.delete(absentUserId)
          }, MEMBER_ABSENCE_TIMEOUT_MS))
        }
      })
    })

    // ── Presence rejoin: cancel absence timers ──
    _partyChannel.on('presence', { event: 'join' }, (payload: { newPresences: { userId: string }[] }) => {
      payload.newPresences.forEach((p) => {
        const pData = p as unknown as { userId: string }
        const store = useWatchPartyStore.getState()

        // Cancel host absence timer if host rejoined
        if (store.currentParty?.hostId === pData.userId && !store.isHost) {
          if (_hostLeftTimer) {
            clearTimeout(_hostLeftTimer)
            _hostLeftTimer = null
            _hostLeftAt = null
          }
        }

        // Cancel member absence timer if member rejoined
        const memberTimer = _memberLeftTimers.get(pData.userId)
        if (memberTimer) {
          clearTimeout(memberTimer)
          _memberLeftTimers.delete(pData.userId)
        }
      })
    })

    // ── Subscribe and track presence ────────────────────────
    _partyChannel.subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        console.log('[WatchParty] Party channel subscribed successfully')
        _restFallbackCount = 0
        try {
          await _partyChannel!.track({
            userId,
            displayName,
            avatarUrl,
            isTalking: false,
          })
        } catch (trackErr) {
          console.error('[WatchParty] Failed to track presence:', trackErr)
          // Non-fatal: the party channel is still usable for broadcasts,
          // but presence-based features (talking indicators, member detection)
          // may not work. The 30s periodic sync provides a fallback.
        }
        useWatchPartyStore.getState().setConnected(true)

        // ── Refresh party state from DB after subscription ──────
        // Broadcasts sent before this client subscribed are lost
        // (Supabase Broadcast is fire-and-forget, not persisted).
        // Fetching the latest DB state ensures we don't miss
        // content-picked or party-started events.
        try {
          const freshParty = await fetchPartyFromDb(partyId)
          if (freshParty) {
            const currentStore = useWatchPartyStore.getState()
            if (currentStore.currentParty) {
              // Update fields that may have changed from broadcasts we missed.
              // Detect content changes (not just initial pick) — the host may
              // have picked or changed content before this client subscribed.
              const needsContentUpdate = freshParty.contentId &&
                (freshParty.contentId !== currentStore.currentParty.contentId ||
                  freshParty.contentTitle !== currentStore.currentParty.contentTitle)
              const needsStatusUpdate = freshParty.status !== currentStore.currentParty.status
              const needsPlaybackUpdate = freshParty.playbackState.isPlaying !== currentStore.currentParty.playbackState.isPlaying

              if (needsContentUpdate) {
                currentStore.setPartyContent({
                  contentId: freshParty.contentId!,
                  mediaType: freshParty.mediaType!,
                  season: freshParty.season,
                  episode: freshParty.episode,
                  contentTitle: freshParty.contentTitle!,
                  contentPoster: freshParty.contentPoster,
                })
                // setPartyContent resets playbackState, so re-apply if needed
                if (freshParty.playbackState.isPlaying) {
                  const updatedStore = useWatchPartyStore.getState()
                  updatedStore.setPlaybackState({ isPlaying: true, currentTime: freshParty.playbackState.currentTime })
                }
              }
              if (needsStatusUpdate) {
                currentStore.setPartyStatus(freshParty.status)
              }
              if (needsPlaybackUpdate && !needsContentUpdate) {
                currentStore.setPlaybackState({
                  isPlaying: freshParty.playbackState.isPlaying,
                  currentTime: freshParty.playbackState.currentTime,
                  pausedBy: freshParty.playbackState.pausedBy,
                })
              }

              // Sync member list from DB (new members, removed members).
              // IMPORTANT: Never downgrade a member's status from 'joined' to
              // 'invited'. The accept API sets status to 'joined' and returns
              // the correct data, but this DB fetch can race with the write
              // on PWA (Supabase read replicas) and return stale 'invited'.
              // Only upgrade statuses (invited → joined) or keep them the same.
              const freshMemberMap = new Map(freshParty.members.map((m) => [m.userId, m]))
              const localMemberMap = new Map(currentStore.currentParty.members.map((m) => [m.userId, m]))

              let needsMemberUpdate = false
              const mergedMembers: typeof freshParty.members = []

              // Start with fresh members from DB
              for (const fm of freshParty.members) {
                const local = localMemberMap.get(fm.userId)
                if (local) {
                  // Member exists locally — prefer the higher status:
                  // 'joined' > 'invited'. This prevents a stale DB read
                  // from downgrading a member who already accepted.
                  const status = (local.memberStatus === 'joined' && fm.memberStatus === 'invited')
                    ? 'joined'
                    : fm.memberStatus
                  const merged = { ...fm, memberStatus: status }
                  if (merged.memberStatus !== local.memberStatus) needsMemberUpdate = true
                  mergedMembers.push(merged)
                } else {
                  // New member not in local state — add them
                  mergedMembers.push(fm)
                  needsMemberUpdate = true
                }
              }

              // Check if any local members were removed from the party
              if (mergedMembers.length !== currentStore.currentParty.members.length) {
                needsMemberUpdate = true
              }

              if (needsMemberUpdate) {
                currentStore.setMembers(mergedMembers)
              }
            }
          }
        } catch { /* non-critical — party state will update via future broadcasts */ }

        // ── Periodic DB sync (safety net for missed broadcasts) ──
        // Supabase Broadcast is fire-and-forget — messages can be lost
        // if the WebSocket connection is flaky. This 30-second refresh
        // catches: content-picked, party-started, member changes, etc.
        if (_syncInterval) clearInterval(_syncInterval)
        _syncInterval = setInterval(async () => {
          if (!_currentPartyId || _syncInProgress) return
          _syncInProgress = true
          try {
            const freshParty = await fetchPartyFromDb(_currentPartyId)
            if (!freshParty) return
            const store = useWatchPartyStore.getState()
            if (!store.currentParty) return

            // If the party was ended (host closed app, etc.), auto-leave.
            // The 'ended' broadcast may not reach us (PWA WS dead, REST
            // fallback cancelled by browser). The host's keepalive API
            // call updates the DB, so this DB poll is the safety net.
            if (freshParty.status === 'ended') {
              toast.info('Watch party has ended')
              store.leaveParty()
              unsubscribePartyChannel()
              return
            }

            // Sync content — update if DB has content that differs from
            // local store (initial pick, missed broadcast, or content change).
            // Previously only synced when local had NO content, which missed
            // content changes and missed broadcasts after the member joined.
            const contentDiffers = freshParty.contentId !== store.currentParty.contentId ||
              (freshParty.contentId && freshParty.contentTitle !== store.currentParty.contentTitle)
            if (freshParty.contentId && contentDiffers) {
              store.setPartyContent({
                contentId: freshParty.contentId,
                mediaType: freshParty.mediaType!,
                season: freshParty.season,
                episode: freshParty.episode,
                contentTitle: freshParty.contentTitle!,
                contentPoster: freshParty.contentPoster,
              })
              if (freshParty.playbackState.isPlaying) {
                useWatchPartyStore.getState().setPlaybackState({
                  isPlaying: true,
                  currentTime: freshParty.playbackState.currentTime,
                })
              }
            }

            // Sync status
            if (freshParty.status !== store.currentParty.status) {
              store.setPartyStatus(freshParty.status)
            }

            // Sync playback state
            const fp = freshParty.playbackState
            const cp = store.currentParty.playbackState
            if (fp.isPlaying !== cp.isPlaying || Math.abs(fp.currentTime - cp.currentTime) > 5) {
              store.setPlaybackState({
                isPlaying: fp.isPlaying,
                currentTime: fp.currentTime,
                pausedBy: fp.pausedBy,
              })
            }

            // Sync members — detect both additions/removals AND status changes
            // (e.g., invited → joined). Never downgrade from 'joined' to 'invited'.
            const currentMemberIds = new Set(store.currentParty.members.map(m => m.userId))
            const freshMemberIds = new Set(freshParty.members.map(m => m.userId))
            const membersAddedOrRemoved = currentMemberIds.size !== freshMemberIds.size ||
              [...currentMemberIds].some(id => !freshMemberIds.has(id))
            const localMemberMap = new Map(store.currentParty.members.map(m => [m.userId, m]))
            const memberStatusUpgraded = freshParty.members.some((fm) => {
              const local = localMemberMap.get(fm.userId)
              if (!local) return false
              // Only count as changed if status UPGRADED (invited → joined),
              // not downgraded (joined → invited from stale DB read)
              if (local.memberStatus === 'joined' && fm.memberStatus === 'invited') return false
              return local.memberStatus !== fm.memberStatus
            })
            if (membersAddedOrRemoved || memberStatusUpgraded) {
              // Merge: keep higher status for existing members
              const merged = freshParty.members.map((fm) => {
                const local = localMemberMap.get(fm.userId)
                if (local && local.memberStatus === 'joined' && fm.memberStatus === 'invited') {
                  return { ...fm, memberStatus: 'joined' as const }
                }
                return fm
              })
              store.setMembers(merged)
            }
          } catch { /* non-critical */ } finally {
            _syncInProgress = false
          }
        }, 30_000)

        // ── Fast content self-heal ──────────────────────────────
        // Polls every 3 seconds to detect the condition:
        //   party status === 'playing' BUT no contentId set.
        // This happens when the content-picked broadcast is lost
        // (WS flaky, REST delivery requires receiver WS to be up).
        // Instead of waiting up to 30s for the periodic sync, this
        // catches it within 3 seconds and fetches content from DB.
        if (_contentHealInterval) { clearInterval(_contentHealInterval); _contentHealInterval = null }
        _contentHealInterval = setInterval(async () => {
          if (!_currentPartyId || _syncInProgress) return
          const store = useWatchPartyStore.getState()
          if (!store.currentParty) return

          // Fast path: detect party ended (host closed app).
          // This 3-second poll ensures members leave within ~3-5 seconds
          // instead of waiting for the 30-second periodic sync.
          // Uses a lightweight status-only query to avoid full party fetch.
          try {
            const { data: statusRow } = await supabase
              .from('watch_parties')
              .select('status')
              .eq('id', _currentPartyId)
              .maybeSingle()
            if (statusRow?.status === 'ended') {
              toast.info('Watch party has ended')
              store.leaveParty()
              unsubscribePartyChannel()
              return
            }
          } catch { /* non-critical */ }

          // Check content from DB. On PWA/mobile, Supabase Broadcast
          // can be lost when WebSocket connections are unreliable.
          // REST fallback delivery also requires the receiver's WS to
          // be up. This poll is the only reliable content delivery path
          // on unstable connections. It uses a lightweight query that
          // only fetches content fields (not members/profiles).
          _syncInProgress = true
          try {
            const { data: contentRow, error: contentError } = await supabase
              .from('watch_parties')
              .select('content_id, media_type, season, episode, content_title, content_poster, is_playing, playback_time, status')
              .eq('id', _currentPartyId)
              .maybeSingle()

            if (contentError || !contentRow) return
            const current = useWatchPartyStore.getState()
            if (!current.currentParty) return

            // Sync content if DB has content that differs from local
            if (contentRow.content_id && contentRow.content_id !== current.currentParty.contentId) {
              current.setPartyContent({
                contentId: contentRow.content_id,
                mediaType: contentRow.media_type as 'movie' | 'tv',
                season: contentRow.season,
                episode: contentRow.episode,
                contentTitle: contentRow.content_title || '',
                contentPoster: contentRow.content_poster,
              })
              if (contentRow.is_playing) {
                current.setPlaybackState({ isPlaying: true, currentTime: contentRow.playback_time || 0 })
              }
            } else if (!contentRow.content_id && current.currentParty.contentId) {
              // Host cleared content — unlikely but handle it
            }

            // Sync member statuses from DB. On PWA, the member-joined
            // broadcast is frequently lost (WebSocket unreliable).
            // REST fallback delivery requires the receiver's WebSocket
            // to be up. This lightweight query catches members who
            // accepted but the host never got the broadcast.
            try {
              const { data: memberRows } = await supabase
                .from('watch_party_members')
                .select('user_id, status')
                .eq('party_id', _currentPartyId)
                .in('status', ['joined', 'invited'])

              if (!memberRows || memberRows.length === 0) return
              const dbStatusMap = new Map(memberRows.map((m) => [m.user_id, m.status]))
              const localMembers = current.currentParty.members
              let needsUpdate = false
              const updatedMembers = localMembers.map((m) => {
                const dbStatus = dbStatusMap.get(m.userId)
                if (!dbStatus) return m
                // Only upgrade: invited → joined. Never downgrade.
                if (m.memberStatus === 'invited' && dbStatus === 'joined') {
                  needsUpdate = true
                  return { ...m, memberStatus: 'joined' as const }
                }
                return m
              })
              // Check for new members not in local state (added by host but
              // broadcast was lost by member)
              const localIds = new Set(localMembers.map((m) => m.userId))
              const newDbMembers = memberRows.filter((m) => !localIds.has(m.user_id) && m.status === 'joined')
              if (newDbMembers.length > 0) {
                // Fetch profiles for new members
                const newIds = newDbMembers.map((m) => m.user_id)
                const { data: profiles } = await supabase
                  .from('profiles')
                  .select('id, display_name, avatar_url')
                  .in('id', newIds)
                const profileMap = new Map((profiles || []).map((p) => [p.id, p]))
                for (const row of newDbMembers) {
                  const profile = profileMap.get(row.user_id)
                  updatedMembers.push({
                    userId: row.user_id,
                    displayName: profile?.display_name || 'Unknown',
                    avatarUrl: profile?.avatar_url || null,
                    isHost: row.user_id === current.currentParty.hostId,
                    isTalking: false,
                    memberStatus: 'joined',
                  })
                  needsUpdate = true
                }
              }
              // Check for members removed from DB (left party)
              const dbIds = new Set(memberRows.map((m) => m.user_id))
              const removedMembers = updatedMembers.filter((m) => !dbIds.has(m.userId))
              if (removedMembers.length > 0) {
                needsUpdate = true
              }
              if (needsUpdate) {
                current.setMembers(updatedMembers.filter((m) => dbIds.has(m.userId)))
              }
            } catch { /* non-critical */ }
          } catch { /* non-critical */ } finally {
            _syncInProgress = false
          }
        }, 3_000)

        // ── Channel keepalive — detect and recover WebSocket drops ──
        // Supabase Realtime WebSocket connections can silently die
        // (no close event, heartbeat timeout). This 15-second check
        // verifies the channel is still joined and forces a
        // resubscribe if it dropped. This is critical because:
        //   - REST fallback for sends works but has higher latency
        //   - WebRTC signaling over REST causes ICE negotiation failures
        //   - PTT broadcasts via REST may not reach receivers whose
        //     WebSocket is also down (REST delivery requires receiver WS)
        if (_keepaliveInterval) clearInterval(_keepaliveInterval)
        _keepaliveInterval = setInterval(() => {
          if (!_partyChannel) return
          const state = _partyChannel.state
          // FIX: Check for 'joined' (Supabase's subscribed state), not 'subscribed'
          // Skip recreation if a sync is already in progress to avoid
          // piling up Supabase REST requests (causes ERR_INSUFFICIENT_RESOURCES)
          if (state !== 'joined' && !_syncInProgress) {
            console.warn('[WatchParty] Keepalive: party channel not joined (state:', state, ') — recreating')
            recreatePartyChannel()
          }
        }, 30_000)

        // ── Ensure voice manager is initialized and renegotiate ──
        // The voice manager is now created eagerly above, but the mic
        // init() might still be in progress. If init() already completed
        // successfully, trigger renegotiation so existing peers get our
        // audio track. If init() is still pending, the PTT handler will
        // handle it on first press.
        if (_voiceManager && _voiceManager.getIsInitialized()) {
          useWatchPartyStore.getState().setVoiceStatus('mic-granted')
          // Renegotiate all existing peer connections now that we have an
          // audio track and the channel is subscribed (signaling works).
          const retryRenegotiate = (attempt: number) => {
            if (attempt > 5 || !_voiceManager?.getIsInitialized()) return
            const delay = attempt === 0 ? 500 : 1500 + attempt * 1000
            setTimeout(() => {
              if (!_voiceManager?.getIsInitialized()) return
              _voiceManager.renegotiateAll().then(() => {
                console.log('[WatchParty] Post-subscribe renegotiation complete (attempt', attempt + 1, ')')
                useWatchPartyStore.getState().setVoiceStatus('connected')
              }).catch((err) => {
                console.warn('[WatchParty] Post-subscribe renegotiation failed (attempt', attempt + 1, '):', err)
                retryRenegotiate(attempt + 1)
              })
            }, delay)
          }
          retryRenegotiate(0)
        }

        // ── Create WebRTC offers for all existing members ─────
        // When joining, existing members will also create offers for us.
        // We initiate offers too for redundancy — the voice manager deduplicates
        // (createOffer returns early if a peer connection already exists).
        //
        // IMPORTANT: First clean up any dead peer connections (failed/disconnected)
        // so that createOffer() doesn't skip them. This is critical when the
        // WebSocket reconnects after a drop — the old peer connections are dead
        // but still in the map, blocking new offers from being created.
        if (_voiceManager) {
          const failedPeers = _voiceManager.cleanupFailedPeers()
          if (failedPeers.length > 0) {
            console.log('[WatchParty] Cleaned up', failedPeers.length, 'dead peer connections — will recreate with fresh offers')
            for (const uid of failedPeers) {
              useWatchPartyStore.getState().setMemberTalking(uid, false)
            }
          }
        }

        const presenceState = _partyChannel!.presenceState()
        const otherUserIds: string[] = []
        Object.values(presenceState).forEach((presences) => {
          presences.forEach((p) => {
            const pData = p as unknown as { userId: string }
            if (pData.userId && pData.userId !== userId) {
              otherUserIds.push(pData.userId)
            }
          })
        })
        for (const uid of otherUserIds) {
          if (_voiceReady) _voiceManager?.createOffer(uid).catch(() => { /* non-critical */ })
        }

        // ── Notify caller that subscription is ready ────────────
        // Used by acceptInvite to broadcast member-joined AFTER the
        // channel is fully subscribed, ensuring the host receives it.
        onSubscribed?.()
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSE') {
        console.error('[WatchParty] Party channel disconnected:', status)
        // Retry subscription with exponential backoff (max 5 attempts)
        // Must recreate the channel since subscribe() can only be called once per instance
        let retryAttempt = 0
        const maxRetries = 5
        const retrySubscribe = () => {
          retryAttempt++
          if (retryAttempt > maxRetries || !_currentPartyId) return
          const delay = Math.min(3000 * retryAttempt, 15000)
          console.log(`[WatchParty] Recreating party channel (attempt ${retryAttempt}/${maxRetries}) in ${delay}ms...`)
          setTimeout(() => {
            if (_currentPartyId && retryAttempt <= maxRetries) {
              recreatePartyChannel()
            }
          }, delay)
        }
        retrySubscribe()
      }
    })
  } catch {
    _partyChannel = null
    _currentPartyId = null
  }
}

function unsubscribePartyChannel() {
  _pttHeld = false
  _pttStoppedUsers.clear()

  // Clear all talking safety timeouts
  for (const [uid, timeout] of _talkingTimeouts) {
    clearTimeout(timeout)
  }
  _talkingTimeouts.clear()

  // Clear periodic sync interval
  if (_syncInterval) {
    clearInterval(_syncInterval)
    _syncInterval = null
  }

  // Clear channel keepalive interval
  if (_keepaliveInterval) {
    clearInterval(_keepaliveInterval)
    _keepaliveInterval = null
  }

  // Clear content self-heal interval
  if (_contentHealInterval) {
    clearInterval(_contentHealInterval)
    _contentHealInterval = null
  }

  // Clear host absence timer
  if (_hostLeftTimer) {
    clearTimeout(_hostLeftTimer)
    _hostLeftTimer = null
    _hostLeftAt = null
  }

  // Clear all member absence timers
  for (const [, timer] of _memberLeftTimers) {
    clearTimeout(timer)
  }
  _memberLeftTimers.clear()

  // Destroy voice manager before removing channel
  if (_voiceManager) {
    _voiceManager.destroy()
    _voiceManager = null
  }
  _voiceReady = false

  // Abort any in-progress voice clip recording
  if (_clipRecorder) {
    _clipRecorder.abort()
    _clipRecorder = null
  }
  // Stop all playing voice clips
  stopAllVoiceClips()
  // Clean up shared AudioContext for iOS voice clip playback
  cleanupAudioContext()
  if (_partyChannel) {
    try { supabase.removeChannel(_partyChannel) } catch { /* already removed */ }
    _partyChannel = null
  }
  _currentPartyId = null
}

// ── Hook ───────────────────────────────────────────────────

export function useWatchParty() {
  const user = useAuthStore((s) => s.user)
  const profile = useAuthStore((s) => s.profile)
  const status = useAuthStore((s) => s.status)

  const setCurrentParty = useWatchPartyStore((s) => s.setCurrentParty)
  const removeInvitation = useWatchPartyStore((s) => s.removeInvitation)
  const setConnected = useWatchPartyStore((s) => s.setConnected)
  const leavePartyStore = useWatchPartyStore((s) => s.leaveParty)

  // ── Subscribe to invites channel when authenticated ──────
  useEffect(() => {
    if (status !== 'authenticated' || !user) return

    subscribeInvitesChannel(user.id)
    setConnected(true)

    fetchPendingInvites(user.id).then((invites) => {
      const store = useWatchPartyStore.getState()
      invites.forEach((inv) => store.addInvitation(inv))
    })

    checkActiveParty(user.id)
  }, [status, user?.id, setConnected])

  // ── Disconnect on logout ──────────────────────────────────
  useEffect(() => {
    if (status === 'unauthenticated') {
      unsubscribeInvitesChannel()
      unsubscribePartyChannel()
      setConnected(false)
      leavePartyStore()
    }
  }, [status, setConnected, leavePartyStore])

  // ── Auto-leave/end party on tab/app close ─────────────────
  // beforeunload: fires on desktop tab close, unreliable in PWA/mobile.
  // pagehide: fires reliably in PWA when swiped away (Android/iOS), also
  //           fires on desktop tab close and navigation away. This is the
  //           PWA-equivalent of beforeunload and is the primary signal
  //           for mobile app termination.
  // Both use fetch({keepalive:true}) which the browser delivers even after
  // the page is gone. Broadcast channel.send() is synchronous.
  useEffect(() => {
    if (typeof window === 'undefined') return

    function sendLeaveSignal(label: string) {
      const store = useWatchPartyStore.getState()
      if (!store.isInParty) return

      const partyId = _currentPartyId ?? store.currentParty?.id
      if (!partyId) return

      // Read token synchronously from localStorage (same as getAuthToken fast-path)
      let token: string | null = null
      try {
        const raw = localStorage.getItem('streamvault-auth-token')
        if (raw) {
          const session = JSON.parse(raw)
          token = session?.access_token
        }
      } catch { /* no token */ }
      if (!token) return

      const action = store.isHost ? 'end' : 'leave'

      // Broadcast to other members.
      // Primary: channel.send() via WebSocket (fastest, synchronous queue).
      // Fallback: channel.httpSend() via HTTP POST to Supabase (survives when
      //   the local WebSocket is closing — the message goes HTTP → Supabase
      //   server → receivers' WebSockets). This is critical for PWA close
      //   where the WS is already tearing down.
      if (_partyChannel) {
        const broadcastPayload: WpBroadcastEvent = store.isHost
          ? { t: 'ended', endedBy: user?.id } as WpEndedEvent
          : { t: 'member-left', userId: user!.id, displayName: profile!.display_name } as WpMemberLeftEvent

        // Try WebSocket first (fast, synchronous queue)
        try {
          const result = _partyChannel.send({ type: 'broadcast', event: 'wp', payload: broadcastPayload })
          detectRestFallback(_partyChannel, result)
        } catch {
          // WebSocket send failed — try HTTP fallback
          try { _partyChannel.httpSend('wp', broadcastPayload) } catch { /* best-effort */ }
        }

        // Also send via httpSend as a reliable backup path.
        // httpSend sends via HTTP POST to Supabase's broadcast endpoint.
        // Even if the WebSocket broadcast above succeeded, this doubles
        // the chance that receivers get the message during page teardown.
        try { _partyChannel.httpSend('wp', broadcastPayload) } catch { /* best-effort */ }
      }

      const apiBody = JSON.stringify({ action, partyId, token })

      // Fire-and-forget API call with keepalive so it survives tab/app close.
      // keepalive is supported on Chrome/Android but NOT on iOS WKWebView
      // (where it is silently ignored and the fetch is cancelled).
      try {
        fetch('/api/watch-party', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: apiBody,
          keepalive: true,
        })
      } catch { /* best-effort */ }

      // sendBeacon is the MOST reliable method for page-unload scenarios.
      // It's designed exactly for this: fire a request when the page is
      // being destroyed. Supported on all modern browsers including iOS.
      // The payload size limit is 64KB which is more than enough for our body.
      try {
        navigator.sendBeacon(
          '/api/watch-party',
          new Blob([apiBody], { type: 'application/json' }),
        )
      } catch { /* best-effort */ }
    }

    function handleBeforeUnload() {
      sendLeaveSignal('ended-beforeunload')
    }

    function handlePageHide(event: PageTransitionEvent) {
      // persisted=false means the page is being discarded (not going to bfcache)
      // In PWA, swiping away always results in persisted=false
      if (event.persisted === false) {
        sendLeaveSignal('ended-pagehide')
      }
    }

    window.addEventListener('beforeunload', handleBeforeUnload)
    window.addEventListener('pagehide', handlePageHide)
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload)
      window.removeEventListener('pagehide', handlePageHide)
    }
  }, [user, profile])

  // ── Helper: resolve party ID from module state or store ──
  const resolvePartyId = useCallback((): string | null => {
    if (_currentPartyId) return _currentPartyId
    const storeParty = useWatchPartyStore.getState().currentParty
    return storeParty?.id ?? null
  }, [])

  // ── Exposed actions ───────────────────────────────────────

  const createRoom = useCallback(async (): Promise<WatchPartyData | null> => {
    if (!user || !profile) {
      toast.error('Please sign in to create a watch party')
      return null
    }

    const result = await wpApi('create')

    if (!result.ok) {
      toast.error(result.error || 'Failed to create watch party')
      return null
    }

    const p = result.data.party as Record<string, unknown>
    const partyData: WatchPartyData = {
      id: p.id as string,
      hostId: p.hostId as string,
      contentId: (p.contentId as string) ?? null,
      mediaType: (p.mediaType as 'movie' | 'tv') ?? null,
      season: (p.season as number) ?? null,
      episode: (p.episode as number) ?? null,
      contentTitle: (p.contentTitle as string) ?? null,
      contentPoster: (p.contentPoster as string) ?? null,
      status: (p.status as 'waiting' | 'playing' | 'ended') ?? 'waiting',
      members: (p.members as PartyMember[]) ?? [],
      playbackState: {
        isPlaying: (p.isPlaying as boolean) ?? false,
        currentTime: (p.playbackTime as number) ?? 0,
        duration: 0,
        pausedBy: (p.pausedBy as string) ?? null,
      },
      createdAt: (p.createdAt as number) ?? Date.now(),
    }

    setCurrentParty(partyData)
    useWatchPartyStore.setState({ isHost: true, isRoomVisible: true })

    subscribePartyChannel(partyData.id, user.id, profile.display_name, profile.avatar_url)

    return partyData
  }, [user, profile, setCurrentParty])

  const inviteUser = useCallback(async (partyId: string, targetUserId: string): Promise<boolean> => {
    if (!user || !profile) {
      toast.error('Please sign in to send invitations')
      return false
    }

    const result = await wpApi('invite', { partyId, targetUserId })

    if (!result.ok) {
      toast.error(result.error || 'Failed to send invitation')
      return false
    }

    // Broadcast invite to target user's per-user invites channel.
    // Each user subscribes to wp-invites-${theirUserId} so they only
    // receive their own invites (fixes privacy leak from shared channel).
    const targetInvitesChannel = supabase.channel(`wp-invites-${targetUserId}`, {
      config: { broadcast: { self: true } },  // self:true so we can send on this channel
    })
    const inviteStore = useWatchPartyStore.getState()
    const memberCount = inviteStore.currentParty?.members.length ?? 1
    const hostData = result.data.hostProfile as { hostName: string; hostAvatarUrl: string | null } | undefined

    // Subscribe briefly just to send, then unsubscribe. We don't need to
    // listen on this channel since it belongs to the target user.
    targetInvitesChannel.subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        wpBroadcast(targetInvitesChannel, {
            t: 'invite',
            partyId,
            hostId: user.id,
            hostName: hostData?.hostName || profile.display_name,
            hostAvatarUrl: hostData?.hostAvatarUrl || profile.avatar_url,
            memberCount,
            targetUserId,
          } as WpInviteEvent, 'invite')
        // Unsubscribe after sending — we don't need to stay on this channel
        setTimeout(() => {
          try { supabase.removeChannel(targetInvitesChannel) } catch { /* already removed */ }
        }, 2000)
      }
    })

    // Add the invited user to local members list immediately
    const store = useWatchPartyStore.getState()
    if (store.currentParty) {
      const alreadyInList = store.currentParty.members.some((m) => m.userId === targetUserId)
      if (!alreadyInList) {
        const invitedMember = result.data.invitedMember as PartyMember | undefined
        store.setMembers([...store.currentParty.members, invitedMember ?? {
          userId: targetUserId,
          displayName: 'Unknown',
          avatarUrl: null,
          isHost: false,
          isTalking: false,
          memberStatus: 'invited',
        }])
      }
    }

    return true
  }, [user, profile])

  const acceptInvite = useCallback(async (partyId: string): Promise<WatchPartyData | null> => {
    if (!user || !profile) {
      toast.error('Please sign in to join a watch party')
      return null
    }

    const result = await wpApi('accept', { partyId })

    if (!result.ok) {
      toast.error(result.error || 'Failed to join watch party')
      return null
    }

    const p = result.data.party as Record<string, unknown> | undefined
    let partyData: WatchPartyData | null = null

    if (p) {
      partyData = {
        id: p.id as string,
        hostId: p.hostId as string,
        contentId: (p.contentId as string) ?? null,
        mediaType: (p.mediaType as 'movie' | 'tv') ?? null,
        season: (p.season as number) ?? null,
        episode: (p.episode as number) ?? null,
        contentTitle: (p.contentTitle as string) ?? null,
        contentPoster: (p.contentPoster as string) ?? null,
        status: (p.status as 'waiting' | 'playing' | 'ended') ?? 'waiting',
        members: (p.members as PartyMember[]) ?? [],
        playbackState: {
          isPlaying: (p.isPlaying as boolean) ?? false,
          currentTime: (p.playbackTime as number) ?? 0,
          duration: 0,
          pausedBy: (p.pausedBy as string) ?? null,
        },
        createdAt: (p.createdAt as number) ?? Date.now(),
      }
    }

    if (!partyData || partyData.status === 'ended') {
      toast.error('This watch party has already ended')
      return null
    }

    setCurrentParty(partyData)
    useWatchPartyStore.setState({
      isHost: partyData.hostId === user.id,
      isRoomVisible: true,
      partyStartTime: partyData.playbackState.currentTime,
    })
    removeInvitation(partyId)

    // Subscribe to party channel and broadcast member-joined AFTER
    // the channel is fully subscribed. Previously, the broadcast was
    // sent immediately after subscribePartyChannel(), but the channel
    // subscription is async — the broadcast would fire before the
    // channel was connected, so the host never received it.
    subscribePartyChannel(partyId, user.id, profile.display_name, profile.avatar_url, () => {
      if (_partyChannel) {
        wpBroadcast(_partyChannel, {
            t: 'member-joined',
            member: {
              userId: user!.id,
              displayName: profile!.display_name,
              avatarUrl: profile!.avatar_url,
              isHost: partyData!.hostId === user!.id,
              isTalking: false,
              memberStatus: 'joined',
            },
          } as WpMemberJoinedEvent, 'member-joined')
      }
    })

    toast.success('Joined watch party!')
    return partyData
  }, [user, profile, setCurrentParty, removeInvitation])

  const rejectInvite = useCallback(async (partyId: string, hostId: string) => {
    if (!user || !profile) {
      toast.error('Please sign in to respond to invitations')
      return
    }

    const result = await wpApi('reject', { partyId })

    if (!result.ok) {
      toast.error(result.error || 'Failed to decline invitation')
    }

    removeInvitation(partyId)

    // Notify host via invites channel
    if (_invitesChannel) {
      wpBroadcast(_invitesChannel, {
          t: 'invite-rejected',
          partyId,
          userId: user.id,
          displayName: profile.display_name,
          targetUserId: hostId,
        } as WpInviteRejectedEvent, 'invite-rejected')
    }
  }, [user, profile, removeInvitation])

  const pickContent = useCallback(async (data: {
    contentId: string
    mediaType: 'movie' | 'tv'
    season?: number
    episode?: number
    contentTitle: string
    contentPoster?: string
  }): Promise<boolean> => {
    if (!user) return false
    const partyId = resolvePartyId()
    if (!partyId) return false

    const result = await wpApi('pick-content', {
      partyId,
      contentId: data.contentId,
      mediaType: data.mediaType,
      season: data.season ?? null,
      episode: data.episode ?? null,
      contentTitle: data.contentTitle,
      contentPoster: data.contentPoster ?? null,
    })

    if (!result.ok) {
      toast.error(result.error || 'Failed to set content')
      console.error('[WatchParty] Pick content API failed:', result.error)
      return false
    }

    // Update local store
    const store = useWatchPartyStore.getState()
    const isContentChange = store.currentParty?.contentId !== data.contentId
    const wasPlaying = store.currentParty?.playbackState.isPlaying ?? false

    store.setPartyContent({
      contentId: data.contentId,
      mediaType: data.mediaType,
      season: data.season ?? null,
      episode: data.episode ?? null,
      contentTitle: data.contentTitle,
      contentPoster: data.contentPoster ?? null,
    })

    // If the party was already playing and this is a content change,
    // re-apply the playing state (setPartyContent resets it)
    if (isContentChange && wasPlaying) {
      useWatchPartyStore.getState().setPlaybackState({ isPlaying: true, currentTime: 0, pausedBy: null })
      useWatchPartyStore.getState().setPartyStartTime(0)
    }

    // Broadcast to other party members.
    // Use wpBroadcast for WebSocket + REST fallback detection.
    // Also explicitly httpSend as a second path — on PWA, the WebSocket
    // may be unreliable and REST fallback broadcast delivery requires
    // the receiver's WebSocket to be up. The httpSend goes HTTP →
    // Supabase server → receiver WebSocket, maximizing delivery odds.
    if (_partyChannel) {
      const contentPayload: WpContentPickedEvent = {
        t: 'content-picked',
        contentId: data.contentId,
        mediaType: data.mediaType,
        season: data.season ?? null,
        episode: data.episode ?? null,
        contentTitle: data.contentTitle,
        contentPoster: data.contentPoster ?? null,
      }
      wpBroadcast(_partyChannel, contentPayload, 'content-picked')
      try { _partyChannel.httpSend('wp', contentPayload) } catch { /* best-effort */ }
      console.log('[WatchParty] Content picked:', data.contentTitle)

      // If the party was already playing, also broadcast a 'played' event
      // so members start the new content immediately
      if (wasPlaying && isContentChange && user && profile) {
        wpBroadcast(_partyChannel, {
            t: 'played',
            currentTime: 0,
            resumedBy: user.id,
            resumedByName: profile.display_name,
          } as WpPlayedEvent, 'played-content-change')
        console.log('[WatchParty] Broadcast played event for content change')
      }
    }

    return true
  }, [user, profile, resolvePartyId])

  const startParty = useCallback(async (currentTime?: number): Promise<boolean> => {
    if (!user) return false
    const partyId = resolvePartyId()
    if (!partyId) return false

    const time = currentTime ?? 0

    const result = await wpApi('start', { partyId, currentTime: time })

    if (!result.ok) {
      toast.error(result.error || 'Failed to start watch party')
      console.error('[WatchParty] Failed to start party:', result.error)
      return false
    }

    // Update local store
    const store = useWatchPartyStore.getState()
    store.setPartyStatus('playing')
    store.setPlaybackState({ isPlaying: true, currentTime: time, pausedBy: null })
    store.setPartyStartTime(time)

    // Broadcast to party — include content info so members who missed
    // the content-picked broadcast can still auto-play immediately
    if (_partyChannel) {
      const cp = store.currentParty
      wpBroadcast(_partyChannel, {
          t: 'party-started',
          currentTime: time,
          contentId: cp?.contentId ?? undefined,
          mediaType: cp?.mediaType ?? undefined,
          season: cp?.season ?? undefined,
          episode: cp?.episode ?? undefined,
          contentTitle: cp?.contentTitle ?? undefined,
          contentPoster: cp?.contentPoster ?? undefined,
        } as WpPartyStartedEvent, 'party-started')
      console.log('[WatchParty] Party started with content:', cp?.contentTitle)
    }

    return true
  }, [user, resolvePartyId])

  const sendPause = useCallback(async (currentTime: number) => {
    if (!user || !profile) return
    const partyId = resolvePartyId()
    if (!partyId) return

    const result = await wpApi('pause', { partyId, currentTime })

    if (!result.ok) {
      // Non-critical — still update local state
    }

    // Update local store regardless
    const store = useWatchPartyStore.getState()
    store.setPlaybackState({ isPlaying: false, pausedBy: user.id, currentTime })
    store.showPauseNotification({ pausedByName: profile.display_name, currentTime })

    // Broadcast to party
    if (_partyChannel) {
      wpBroadcast(_partyChannel, {
          t: 'paused',
          pausedBy: user.id,
          pausedByName: profile.display_name,
          currentTime,
        } as WpPausedEvent, 'paused')
    }
  }, [user, profile, resolvePartyId])

  const sendPlay = useCallback(async (currentTime: number): Promise<boolean> => {
    if (!user || !profile) return false
    const partyId = resolvePartyId()
    if (!partyId) return false

    const result = await wpApi('play', { partyId, currentTime })

    if (!result.ok) {
      // Non-critical — still update local state
    }

    // Update local store
    const store = useWatchPartyStore.getState()
    store.setPlaybackState({ isPlaying: true, pausedBy: null, currentTime })
    store.clearPauseNotification()

    // Broadcast to party
    if (_partyChannel) {
      wpBroadcast(_partyChannel, {
          t: 'played',
          currentTime,
          resumedBy: user.id,
          resumedByName: profile.display_name,
        } as WpPlayedEvent, 'played')
    }

    return true
  }, [user, profile, resolvePartyId])

  const sendSeek = useCallback(async (currentTime: number): Promise<boolean> => {
    if (!user || !profile) return false
    const partyId = resolvePartyId()
    if (!partyId) return false

    const result = await wpApi('seek', { partyId, currentTime })

    if (!result.ok) {
      // Non-critical
    }

    // Update local store
    useWatchPartyStore.getState().setPlaybackState({ currentTime })

    // Broadcast to party
    if (_partyChannel) {
      wpBroadcast(_partyChannel, {
          t: 'seeked',
          currentTime,
          seekedBy: user.id,
          seekedByName: profile.display_name,
        } as WpSeekedEvent, 'seeked')
    }

    return true
  }, [user, profile, resolvePartyId])

  const sendSync = useCallback(async (currentTime: number, isPlaying: boolean, _duration: number) => {
    const partyId = resolvePartyId()
    if (!partyId) return

    // Write to DB for persistence (debounced — max once per 5s)
    // 500ms broadcast via wpBroadcast is for real-time sync.
    // DB persistence is only for rejoin recovery — 5s granularity is fine.
    debouncedSyncToDb(partyId, currentTime, isPlaying)

    // Broadcast to members for real-time sync
    if (_partyChannel) {
      wpBroadcast(_partyChannel, {
          t: 'sync',
          currentTime,
          isPlaying,
          sentAt: Date.now(),
        } as WpSyncEvent, 'sync')
    }
  }, [resolvePartyId])

  const sendPttStart = useCallback(async () => {
    _pttHeld = true
    useWatchPartyStore.setState({ isPttActive: true })

    // ── iOS: Voice clip recording (NOT WebRTC) ─────────────
    // On iOS, getUserMedia() forces AVAudioSession into .playAndRecord which
    // ducks all audio output. Even after track.stop(), PeerConnections keep
    // the session alive permanently. Instead, we record a short clip during
    // PTT hold and forward it via broadcast — mic is freed on release.
    if (isIOSDevice()) {
      // Initialize Web Audio API context during this user gesture.
      // On iOS, audio.play() requires a gesture context. The AudioContext
      // created here stays "warm" and can decode+play voice clips without
      // gesture context for the entire party session.
      initAudioContext()

      useWatchPartyStore.getState().setVoiceStatus('mic-requesting')
      const recorder = new VoiceClipRecorder()
      _clipRecorder = recorder
      const ok = await recorder.startRecording()
      if (ok) {
        useWatchPartyStore.getState().setVoiceStatus('recording')
      } else {
        useWatchPartyStore.getState().setVoiceStatus('mic-denied', 'Microphone access denied')
        toast.error('Microphone access denied — voice unavailable', { duration: 4000 })
        _pttHeld = false
        useWatchPartyStore.setState({ isPttActive: false })
        return
      }

      // Broadcast PTT start for speaking indicator
      if (_partyChannel && _pttHeld) {
        const currentUser = useAuthStore.getState().user
        const currentProfile = useAuthStore.getState().profile
        const pttUserId = currentUser?.id
        if (!pttUserId) return

        const channel = _partyChannel
        wpBroadcast(channel, {
          t: 'ptt-start',
          userId: pttUserId,
          displayName: currentProfile?.display_name || 'Unknown',
        } as WpPttStartEvent, 'ptt-start')

        try {
          await channel.track({
            userId: pttUserId,
            displayName: currentProfile?.display_name,
            avatarUrl: currentProfile?.avatar_url,
            isTalking: true,
          })
        } catch { /* presence update non-critical */ }
      }
      return
    }

    // ── Non-iOS: WebRTC PTT (unchanged) ───────────────────
    // ── Ensure voice manager exists — create on-the-spot if needed ──
    // If the subscription never reached 'SUBSCRIBED' (e.g. Realtime
    // stuck in CONNECTING), _voiceManager may still be null. As a safety
    // net, create it here so PTT always works.
    if (!_voiceManager) {
      const currentUser = useAuthStore.getState().user
      const currentUserId = currentUser?.id
      if (currentUserId) {
        _voiceManager = new WebRtcVoiceManager(currentUserId)
        console.log('[WatchParty] Voice manager created on-the-spot during PTT press')
        _voiceManager.setSignalSender((targetUserId, signal) => {
          if (!_partyChannel) return
          let payload: WpWebrtcEvent
          switch (signal.type) {
            case 'offer':
              payload = { t: 'webrtc-offer', targetUserId, fromUserId: currentUserId, sdp: signal.sdp! }
              break
            case 'answer':
              payload = { t: 'webrtc-answer', targetUserId, fromUserId: currentUserId, sdp: signal.sdp! }
              break
            case 'ice-candidate':
              payload = { t: 'webrtc-ice', targetUserId, fromUserId: currentUserId, candidate: signal.candidate! }
              break
          }
          wpBroadcast(_partyChannel, payload, `webrtc-${payload.t}`)
        })
        _voiceManager.setOnRemoteStream((remoteUserId, _stream) => {
          console.log('[WatchParty] Remote stream received from', remoteUserId)
          _voiceManager?.retryPausedAudio()
        })
        _voiceManager.setOnRemoteStreamRemoved((remoteUserId) => {
          useWatchPartyStore.getState().setMemberTalking(remoteUserId, false)
        })
      }
    }

    if (_voiceManager) {
      const wasInitialized = _voiceManager.getIsInitialized()

      // Track mic request state for diagnostics
      if (!wasInitialized) {
        useWatchPartyStore.getState().setVoiceStatus('mic-requesting')
        console.log('[WatchParty] Requesting microphone access...')
      }

      const initOk = await _voiceManager.init()

      if (!initOk) {
        useWatchPartyStore.getState().setVoiceStatus('mic-denied', 'Microphone access denied')
        toast.error('Microphone access denied — voice chat unavailable', { duration: 4000 })
        return
      }

      _voiceReady = true

      if (!wasInitialized) {
        useWatchPartyStore.getState().setVoiceStatus('mic-granted')

        // ── Create pending WebRTC offers for existing members ───
        // Peer connections were deferred until voice init to prevent
        // AVAudioSession switch on iOS/Android. Now that mic is ready,
        // create offers for all current party members.
        const party = useWatchPartyStore.getState().currentParty
        if (party) {
          for (const member of party.members) {
            if (member.userId !== _subscribedUserId) {
              _voiceManager?.createOffer(member.userId).catch(() => {})
            }
          }
        }
      }

      // ── Race condition guard ──────────────────────────────────
      if (!_pttHeld) {
        _voiceManager.setMuted(true)
        console.log('[WatchParty] PTT released during mic init — staying muted')
        return
      }

      // ── Ensure audio is properly configured on ALL peer connections ──
      try {
        await _voiceManager.ensureAudioSending()
      } catch (err) {
        console.warn('[WatchParty] ensureAudioSending failed (non-critical):', err)
      }

      // Unmute the local audio track so voice is transmitted
      _voiceManager.setMuted(false)

      // If this is the first time the mic was initialized, existing peer
      // connections need renegotiation so the new audio track is sent.
      if (!wasInitialized && _voiceManager.getIsInitialized()) {
        useWatchPartyStore.getState().setVoiceStatus('connecting')
        console.log('[WatchParty] Renegotiating WebRTC peer connections for audio...')
        try {
          await _voiceManager.renegotiateAll()
          useWatchPartyStore.getState().setVoiceStatus('connected')
          console.log('[WatchParty] WebRTC renegotiation complete — voice connected')
        } catch (err) {
          console.error('[WatchParty] WebRTC renegotiation failed:', err)
          setTimeout(async () => {
            if (_voiceManager?.getIsInitialized()) {
              try {
                await _voiceManager.renegotiateAll()
                useWatchPartyStore.getState().setVoiceStatus('connected')
                console.log('[WatchParty] WebRTC renegotiation retry succeeded')
              } catch (retryErr) {
                console.error('[WatchParty] WebRTC renegotiation retry also failed:', retryErr)
                useWatchPartyStore.getState().setVoiceStatus('error', 'Voice connection failed')
              }
            }
          }, 1500)
        }
      }

      // Retry any paused remote audio elements (browser autoplay policy
      // requires a user gesture — PTT press counts as one)
      _voiceManager.retryPausedAudio()
    } else {
      console.warn('[WatchParty] Voice manager not available — PTT pressed but no voice connection')
    }

    // Broadcast PTT start for immediate indicator (faster than presence)
    // Only broadcast if PTT is still held (user may have released during init)
    if (_partyChannel && _pttHeld) {
      const currentUser = useAuthStore.getState().user
      const currentProfile = useAuthStore.getState().profile
      const pttUserId = currentUser?.id
      if (!pttUserId) return

      // Capture channel locally — wpBroadcast() can synchronously trigger
      // detectRestFallback → recreatePartyChannel → _partyChannel = null.
      const channel = _partyChannel

      wpBroadcast(channel, {
          t: 'ptt-start',
          userId: pttUserId,
          displayName: currentProfile?.display_name || 'Unknown',
        } as WpPttStartEvent, 'ptt-start')

      // Also update presence for redundancy (use local capture)
      if (channel) {
        try {
          await channel.track({
            userId: pttUserId,
            displayName: currentProfile?.display_name,
            avatarUrl: currentProfile?.avatar_url,
            isTalking: true,
          })
        } catch (err) {
          console.warn('[WatchParty] Failed to update presence for PTT start:', err)
        }
      }
    }
  }, [])

  const sendPttStop = useCallback(async () => {
    // Idempotency guard: if channel recreation or leave already cleared _pttHeld,
    // the PTT was programmatically released — this button-up is a stale event.
    if (!_pttHeld) return

    _pttHeld = false

    // ── iOS: Stop recording, send voice clip ────────────────
    if (isIOSDevice()) {
      const recorder = _clipRecorder
      _clipRecorder = null
      useWatchPartyStore.setState({ isPttActive: false })
      useWatchPartyStore.getState().setVoiceStatus('connected')

      if (recorder && _partyChannel) {
        const clip = await recorder.stopRecording()
        if (clip && clip.blob.size > 0) {
          try {
            const base64 = await encodeClipToBase64(clip.blob)
            const currentUser = useAuthStore.getState().user
            const currentProfile = useAuthStore.getState().profile
            const channel = _partyChannel

            wpBroadcast(channel, {
              t: 'voice-clip',
              fromUserId: currentUser?.id || '',
              displayName: currentProfile?.display_name || 'Unknown',
              audio: base64,
              mimeType: clip.blob.type || 'audio/webm',
              duration: clip.duration,
            } as WpVoiceClipEvent, 'voice-clip')
          } catch {
            // Encoding or broadcast failed — clip is lost but benign
          }
        }
      } else if (recorder) {
        recorder.abort()
      }

      // Broadcast PTT stop for speaking indicator
      if (_partyChannel) {
        const currentUser = useAuthStore.getState().user
        const pttUserId = currentUser?.id
        if (pttUserId) {
          const channel = _partyChannel
          wpBroadcast(channel, {
            t: 'ptt-stop',
            userId: pttUserId,
          } as WpPttStopEvent, 'ptt-stop')

          try {
            await channel.track({
              userId: pttUserId,
              displayName: useAuthStore.getState().profile?.display_name,
              avatarUrl: useAuthStore.getState().profile?.avatar_url,
              isTalking: false,
            })
          } catch { /* presence update non-critical */ }
        }
      }
      return
    }

    // ── Non-iOS: WebRTC PTT stop (unchanged) ──────────────
    // RELEASE MIC FIRST — before any React state updates or async operations.
    // On iOS, track.stop() switches AVAudioSession from .playAndRecord back to
    // .playback, restoring movie audio volume. Calling this before setState
    // ensures the OS receives the release signal at the earliest possible moment,
    // before any React re-rendering adds delay on slower PWA hardware.
    if (_voiceManager) {
      _voiceManager.setMuted(true)
    } else {
      console.warn('[WatchParty] Voice manager not available on PTT stop')
    }

    // Update UI after mic is released (state update triggers React re-render)
    useWatchPartyStore.setState({ isPttActive: false })

    if (!_partyChannel) {
      // Channel is null during recreation — broadcast is lost but benign.
      // The talking indicator will clear via presence sync or next subscription cycle.
      return
    }

    // Capture channel locally — wpBroadcast() can synchronously trigger
    // detectRestFallback → recreatePartyChannel → _partyChannel = null.
    // Without this, _partyChannel.track() below would crash on null.
    const channel = _partyChannel

    // Broadcast PTT stop for immediate indicator clearing
    const currentUser = useAuthStore.getState().user
    const currentProfile = useAuthStore.getState().profile
    const pttUserId = currentUser?.id
    if (!pttUserId) return

    wpBroadcast(channel, {
        t: 'ptt-stop',
        userId: pttUserId,
      } as WpPttStopEvent, 'ptt-stop')

    // Also update presence for redundancy (use local capture — channel may be gone)
    if (channel) {
      try {
        await channel.track({
          userId: pttUserId,
          displayName: currentProfile?.display_name,
          avatarUrl: currentProfile?.avatar_url,
          isTalking: false,
        })
      } catch (err) {
        console.warn('[WatchParty] Failed to update presence for PTT stop:', err)
      }
    }
  }, [])

  const leaveRoom = useCallback(async () => {
    const partyId = resolvePartyId()

    try {
      if (user && partyId) {
        const result = await wpApi('leave', { partyId })
        if (!result.ok) {
          console.warn('[WatchParty] Leave API failed:', result.error)
        }
      }

      // Broadcast leave to remaining party members
      if (_partyChannel && user && profile) {
        wpBroadcast(_partyChannel, {
            t: 'member-left',
            userId: user.id,
            displayName: profile.display_name,
          } as WpMemberLeftEvent, 'member-left')
      }

      unsubscribePartyChannel()
      leavePartyStore()
      toast.success('Left the watch party')
      console.log('[WatchParty] Left party successfully')
    } catch (err) {
      console.error('[WatchParty] Error leaving party:', err)
      unsubscribePartyChannel()
      leavePartyStore()
      toast.success('Left the watch party')
    }
  }, [user, profile, leavePartyStore, resolvePartyId])

  const endRoom = useCallback(async (): Promise<boolean> => {
    const partyId = resolvePartyId()

    // Broadcast end to party members FIRST, before any API call or
    // channel teardown. The broadcast is the real-time signal that
    // members rely on. Previously the API call ran first, and if it
    // failed (network error, 429), the broadcast never fired —
    // leaving members orphaned in the party indefinitely.
    if (_partyChannel) {
      wpBroadcast(_partyChannel, {
          t: 'ended',
          endedBy: user?.id,
        } as WpEndedEvent, 'ended')
      console.log('[WatchParty] End broadcast sent')
    }

    try {
      if (user && partyId) {
        const result = await wpApi('end', { partyId })
        if (!result.ok) {
          // API failed but broadcast already went out — members will
          // still leave. We still clean up locally.
          console.error('[WatchParty] End API failed:', result.error)
        }
      }
    } catch {
      // Best-effort API call
    }

    unsubscribePartyChannel()
    leavePartyStore()
    toast.success('Watch party ended')
    console.log('[WatchParty] Party ended successfully')
    return true
  }, [user, leavePartyStore, resolvePartyId])

  // ── Broadcast profile update to party members ───────────
  // Called when the current user changes their display_name or avatar.
  // Updates the local party member entry immediately and broadcasts
  // the change so other party members see it instantly too.
  const broadcastProfileUpdate = useCallback((displayName: string, avatarUrl: string | null) => {
    if (!user) return

    // Update own member data in the local party store immediately
    useWatchPartyStore.getState().updateMemberProfile(user.id, { displayName, avatarUrl })

    // Broadcast to other party members
    if (_partyChannel) {
      wpBroadcast(_partyChannel, {
          t: 'profile-updated',
          userId: user.id,
          displayName,
          avatarUrl,
        } as WpProfileUpdatedEvent, 'profile-updated')
    }
  }, [user])

  return {
    createRoom,
    inviteUser,
    acceptInvite,
    rejectInvite,
    pickContent,
    startParty,
    sendPause,
    sendPlay,
    sendSeek,
    sendSync,
    sendPttStart,
    sendPttStop,
    broadcastProfileUpdate,
    leaveRoom,
    endRoom,
    /** Returns the sentAt (ms) of the most recent sync broadcast from the host */
    getLastSyncSentAt: () => _lastSyncSentAt,
  }
}
