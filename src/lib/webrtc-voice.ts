/**
 * StreamVault — WebRTC Voice Manager for Watch Party
 *
 * Manages peer-to-peer audio connections between watch party members
 * using a mesh topology. Signaling is delegated to the caller via
 * callbacks (connected to Supabase Realtime broadcast).
 *
 * Lifecycle:
 *   1. Construct with local userId
 *   2. Set signal sender + remote stream callbacks
 *   3. Call init() to request microphone access
 *   4. Call createOffer() for each remote member
 *   5. Route incoming signaling via handleOffer / handleAnswer / handleIceCandidate
 *   6. Call removePeer() when a member leaves, destroy() on party end
 */

// ── Types ──────────────────────────────────────────────────

export interface WebRtcSignal {
  type: 'offer' | 'answer' | 'ice-candidate'
  sdp?: string
  candidate?: RTCIceCandidateInit
}

export type SignalSender = (targetUserId: string, signal: WebRtcSignal) => void
export type RemoteStreamHandler = (userId: string, stream: MediaStream) => void
export type RemoteStreamRemovedHandler = (userId: string) => void

/** Signaling event shapes broadcast via Supabase Realtime */
export interface WpWebrtcOfferEvent {
  t: 'webrtc-offer'
  targetUserId: string
  fromUserId: string
  sdp: string
}

export interface WpWebrtcAnswerEvent {
  t: 'webrtc-answer'
  targetUserId: string
  fromUserId: string
  sdp: string
}

export interface WpWebrtcIceEvent {
  t: 'webrtc-ice'
  targetUserId: string
  fromUserId: string
  candidate: RTCIceCandidateInit
}

export type WpWebrtcEvent =
  | WpWebrtcOfferEvent
  | WpWebrtcAnswerEvent
  | WpWebrtcIceEvent

// ── Internal peer state ────────────────────────────────────

interface PeerState {
  pc: RTCPeerConnection
  /** ICE candidates that arrived before the remote description was set */
  pendingIce: RTCIceCandidateInit[]
 /** Number of consecutive ICE restart attempts that failed */
  iceRestartAttempts: number
}

/** Diagnostic info for a single peer connection (used for debugging). */
export interface PeerDiagnosticInfo {
  userId: string
  signalingState: RTCSignalingState
  iceConnectionState: RTCIceConnectionState
  connectionState: RTCPeerConnectionState
  iceRestartAttempts: number
  hasLocalAudioTrack: boolean
  hasRemoteAudioTrack: boolean
  pendingIceCandidates: number
}

/** Diagnostic info for the entire voice manager (used for debugging). */
export interface VoiceManagerDiagnosticInfo {
  userId: string
  isInitialized: boolean
  isMuted: boolean
  isDestroyed: boolean
  hasLocalStream: boolean
  localAudioTrackCount: number
  peerCount: number
  peers: PeerDiagnosticInfo[]
  pendingRenegotiationUserIds: string[]
}

// ── ICE Server Configuration ─────────────────────────────
// STUN + TURN servers for WebRTC NAT traversal.
//
// CRITICAL: STUN-only works on the same LAN but FAILS across different
// NATs (the common case for remote users). TURN relay servers are
// required for audio to flow when both peers are behind NAT.
// Without TURN, ICE negotiation fails → no audio on PTT.
//
// We use a two-tier approach:
//   1. Fetch TURN credentials from our API route (which uses the
//      Open Relay Project for free TURN credentials)
//   2. Fall back to STUN-only if the API is unreachable

const STUN_ONLY_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
  ],
}

// Module-level cache for ICE server config with TURN credentials
let _cachedIceConfig: RTCConfiguration | null = null
let _iceConfigExpiry = 0

async function fetchIceConfig(): Promise<RTCConfiguration> {
  // Return cached config if still valid
  if (_cachedIceConfig && Date.now() < _iceConfigExpiry) {
    return _cachedIceConfig
  }

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 6000)
    const res = await fetch('/api/turn-credentials', { signal: controller.signal })
    clearTimeout(timeout)

    if (res.ok) {
      const data = await res.json()
      if (data?.iceServers && Array.isArray(data.iceServers) && data.iceServers.length > 0) {
        _cachedIceConfig = { iceServers: data.iceServers }
        _iceConfigExpiry = Date.now() + 4 * 60 * 60 * 1000
        console.log('[WebRTC] ICE config loaded:', data.iceServers.length, 'servers')
        return _cachedIceConfig
      }
    }
  } catch {
    // API unreachable — fall through to STUN-only
  }

  _cachedIceConfig = STUN_ONLY_CONFIG
  _iceConfigExpiry = Date.now() + 30 * 60 * 1000
  return _cachedIceConfig
}

// ── Error classification helpers ──────────────────────────

/** Classify a DOMException / Error from getUserMedia into a user-friendly category. */
function classifyGetUserMediaError(err: unknown): string {
  if (err instanceof DOMException) {
    switch (err.name) {
      case 'NotAllowedError':
        return 'Microphone permission denied by user or system policy. Please allow microphone access in your browser settings.'
      case 'NotFoundError':
        return 'No microphone found. Please connect a microphone and try again.'
      case 'NotReadableError':
        return 'Microphone is in use by another application or the system denied access. Close other apps using the mic and try again.'
      case 'AbortError':
        return 'Microphone request was aborted (possibly due to page navigation or user cancellation).'
      case 'OverconstrainedError':
        return `Microphone constraint not supported by your device: ${(err as OverconstrainedError).constraint}. Falling back to default audio settings.`
      case 'SecurityError':
        return 'Microphone access blocked by security policy (possible due to insecure context — ensure HTTPS).'
      case 'TypeError':
        return 'Invalid audio constraints provided. This is a bug — please report it.'
    }
  }
  if (err instanceof Error) {
    return `Microphone error: ${err.message}`
  }
  return `Unknown microphone error: ${String(err)}`
}

/** Classify a WebRTC signaling error into a user-friendly category. */
function classifySignalingError(context: string, fromUserId: string, err: unknown): string {
  const prefix = `[WebRTC] ${context} failed for ${fromUserId}`
  if (err instanceof DOMException) {
    switch (err.name) {
      case 'InvalidStateError':
        return `${prefix}: Connection is in an invalid state (${err.message})`
      case 'InvalidAccessError':
        return `${prefix}: Access denied (${err.message})`
      case 'OperationError':
        return `${prefix}: Operation failed — possibly due to glare or concurrent renegotiation (${err.message})`
      case 'RTCError':
        return `${prefix}: RTC error — ${err.message}`
    }
  }
  if (err instanceof Error) {
    return `${prefix}: ${err.message}`
  }
  return `${prefix}: ${String(err)}`
}

// ── Manager ────────────────────────────────────────────────

export class WebRtcVoiceManager {
  private peerConnections: Map<string, PeerState>
  private localStream: MediaStream | null
  private audioElements: Map<string, HTMLAudioElement>
  private signalSender: SignalSender | null
  private onRemoteStream: RemoteStreamHandler | null
  private onRemoteStreamRemoved: RemoteStreamRemovedHandler | null
  private userId: string
  private isMuted: boolean
  private initialized: boolean
  private destroyed: boolean
  private iceConfig: RTCConfiguration
  /** Tracks peers that need renegotiation once they reach 'stable' signaling state */
  private pendingRenegotiation: Set<string>

  constructor(userId: string) {
    this.userId = userId
    this.peerConnections = new Map()
    this.localStream = null
    this.audioElements = new Map()
    this.signalSender = null
    this.onRemoteStream = null
    this.onRemoteStreamRemoved = null
    this.isMuted = true // start muted (PTT: unmute only while pressing)
    this.initialized = false
    this.destroyed = false
    this.iceConfig = STUN_ONLY_CONFIG // Will be upgraded in init()
    this.pendingRenegotiation = new Set()
  }

  // ── Configuration setters ────────────────────────────────

  /** Set the callback used to send signaling messages (connected to Supabase broadcast). */
  setSignalSender(sender: SignalSender): void {
    this.signalSender = sender
  }

  /** Set callback fired when a remote audio stream becomes available. */
  setOnRemoteStream(handler: RemoteStreamHandler): void {
    this.onRemoteStream = handler
  }

  /** Set callback fired when a remote peer disconnects. */
  setOnRemoteStreamRemoved(handler: RemoteStreamRemovedHandler): void {
    this.onRemoteStreamRemoved = handler
  }

  // ── Microphone ───────────────────────────────────────────

  /**
   * Request microphone access. Must be called once before voice can transmit.
   * Also fetches TURN credentials for NAT traversal.
   * Returns false if permission is denied — PTT UI can still render but
   * audio won't be sent.
   *
   * Audio constraints rationale:
   *   - echoCancellation: false — on iOS Safari/WebView, enabling echo
   *     cancellation causes the OS to switch the audio session to "voice chat"
   *     mode which routes audio through the earpiece AND dramatically lowers
   *     ALL output volume (audio ducking). Since watch parties have movie
   *     audio playing simultaneously, this is unacceptable. Disabling echo
   *     cancellation keeps the audio session in "ambient" mode with full
   *     volume output. Some echo may occur on speaker but this is preferable
   *     to inaudible movie audio.
   *   - noiseSuppression: true — filters background noise for cleaner voice.
   *   - autoGainControl: omitted — let the browser use its default (true on
   *     most browsers). CRITICAL: disabling AGC on iOS causes the raw mic
   *     signal to be too weak for WebRTC transmission — nobody can hear you.
   *     The iOS AGC ducking concern was a misdiagnosis; echoCancellation is
   *     the actual iOS ducking trigger, not AGC.
   *   - channelCount: omitted — let the browser/device decide the optimal
   *     channel configuration. Forcing mono (channelCount: 1) could cause
   *     OverconstrainedError on some devices.
   *   - googEchoCancellation: false (Chrome-specific advanced constraint) —
   *     prevents Chrome from applying system-wide echo cancellation which
   *     causes output volume drop even when the standard echoCancellation
   *     constraint is set to false.
   */
  async init(): Promise<boolean> {
    if (this.destroyed) return false
    if (this.initialized) return true

    // Fetch TURN credentials in parallel with mic access
    const turnPromise = fetchIceConfig().then((config) => {
      this.iceConfig = config
    })

    let stream!: MediaStream
    // Try multiple constraint sets in order of preference.
    // googEchoCancellation is Chrome-only — causes OverconstrainedError on
    // Firefox/Safari/Edge. We try with it first (for audio ducking
    // prevention) and fall back to simpler constraints.
    const constraintSets: MediaTrackConstraints[] = [
      {
        echoCancellation: false,
        noiseSuppression: true,
      },
      {}, // browser defaults (equivalent to { audio: true })
    ]

    // On Chrome, also try with googEchoCancellation first
    const isChrome = /Chrome/.test(navigator.userAgent) && !/Edg/.test(navigator.userAgent)
    if (isChrome) {
      constraintSets.unshift({
        echoCancellation: false,
        noiseSuppression: true,
        googEchoCancellation: false,
      } as MediaTrackConstraints & Record<string, unknown>)
    }

    let initSuccess = false
    for (let i = 0; i < constraintSets.length; i++) {
      try {
        const constraints = constraintSets[i]
        console.log(`[WebRTC] Mic init attempt ${i + 1}/${constraintSets.length} with constraints:`, JSON.stringify(constraints))
        stream = await navigator.mediaDevices.getUserMedia({ audio: constraints })
        initSuccess = true
        console.log(`[WebRTC] Mic init succeeded on attempt ${i + 1}`)
        break
      } catch (err) {
        const msg = classifyGetUserMediaError(err)
        console.warn(`[WebRTC] Mic init attempt ${i + 1} failed:`, msg)
        // If it's a permission denial, don't retry — user explicitly denied
        if (err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) {
          console.error('[WebRTC] Microphone permission denied — aborting init')
          this.initialized = false
          return false
        }
        // For OverconstrainedError, NotFoundError, etc., try next constraint set
      }
    }

    if (!initSuccess) {
      console.error('[WebRTC] All mic init attempts failed — microphone unavailable')
      this.initialized = false
      return false
    }

    // Wait for TURN credentials to finish fetching (may have already resolved)
    await turnPromise.catch(() => {
      // TURN fetch failed — STUN-only config is already set as default
      console.warn('[WebRTC] TURN credential fetch failed — using STUN-only')
    })

    this.localStream = stream

    // Apply current muted state to the newly acquired tracks
    for (const track of stream.getAudioTracks()) {
      track.enabled = !this.isMuted
    }

    this.initialized = true

    // Add local tracks to any peer connections that were created before init().
    // MUST be awaited — replaceTrack is async and the track must be set
    // before any renegotiation offer is created.
    await this.addLocalTracksToExistingPeers()

    console.log('[WebRTC] Microphone initialized, tracks:', stream.getAudioTracks().length)
    return true
  }

  /** Mute or unmute the local audio track (push-to-talk).
   *  When muting: stops the local stream tracks entirely to release the OS
   *  audio session back to Playback mode. This is CRITICAL on iOS where
   *  AVAudioSession in .playAndRecord mode dramatically reduces output
   *  volume for the iframe video player. Stopping the tracks returns the
   *  session to .playback and movie audio returns to full volume.
   *  When unmuting: enables tracks on existing stream, or caller must
   *  re-init via init() if stream was released (this.initialized=false).
   */
  setMuted(muted: boolean): void {
    this.isMuted = muted
    if (muted) {
      if (this.localStream) {
        // Platform-aware mic release:
        // - On iOS: stop tracks entirely to return AVAudioSession to .playback
        //   mode. Without this, movie audio stays ducked between PTT presses.
        //   Note: iOS actually uses VoiceClipRecorder (not this class), but
        //   we keep the guard for any edge case where WebRTC is used on iOS.
        // - On all other platforms: just disable tracks (track.enabled = false).
        //   This keeps the stream alive for instant unmute on next PTT press,
        //   avoiding the 200-500ms getUserMedia re-acquisition latency.
        const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
          (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)

        if (isIOS) {
          for (const track of this.localStream.getAudioTracks()) {
            track.stop()
          }
          this.localStream = null
          this.initialized = false
        } else {
          // Disable but don't stop — stream stays alive for instant unmute
          for (const track of this.localStream.getAudioTracks()) {
            track.enabled = false
          }
        }
      }
    } else if (this.localStream) {
      // Stream still alive — just enable tracks (instant on non-iOS)
      for (const track of this.localStream.getAudioTracks()) {
        track.enabled = true
      }
    }
    // If stream was released (this.localStream === null, iOS path), the caller
    // (sendPttStart) will call init() which re-acquires the mic.
  }

  /** Whether the local audio is currently muted. */
  getIsMuted(): boolean {
    return this.isMuted
  }

  /** Whether the mic has been successfully initialized. */
  getIsInitialized(): boolean {
    return this.initialized
  }

  /**
   * Return diagnostic information about all peer connections and local state.
   * Useful for debugging connection issues in production.
   */
  getDiagnosticInfo(): VoiceManagerDiagnosticInfo {
    const peers: PeerDiagnosticInfo[] = []

    for (const [userId, peer] of this.peerConnections) {
      const transceivers = peer.pc.getTransceivers()
      const audioTransceiver = transceivers.find(
        t => t.receiver?.track?.kind === 'audio' || t.sender?.track?.kind === 'audio'
      )

      peers.push({
        userId,
        signalingState: peer.pc.signalingState,
        iceConnectionState: peer.pc.iceConnectionState,
        connectionState: peer.pc.connectionState,
        iceRestartAttempts: peer.iceRestartAttempts,
        hasLocalAudioTrack: !!audioTransceiver?.sender?.track,
        hasRemoteAudioTrack: !!audioTransceiver?.receiver?.track,
        pendingIceCandidates: peer.pendingIce.length,
      })
    }

    return {
      userId: this.userId,
      isInitialized: this.initialized,
      isMuted: this.isMuted,
      isDestroyed: this.destroyed,
      hasLocalStream: !!this.localStream,
      localAudioTrackCount: this.localStream?.getAudioTracks().length ?? 0,
      peerCount: this.peerConnections.size,
      peers,
      pendingRenegotiationUserIds: [...this.pendingRenegotiation],
    }
  }

  /**
   * Renegotiate all existing peer connections.
   *
   * Called after local audio tracks are added to existing peer connections
   * (via addLocalTracksToExistingPeers) when the mic is first initialized.
   * Without renegotiation, the remote peer never learns about the new track
   * and audio won't flow.
   *
   * Creates a new offer for each peer with updated tracks.
   * Peers that are not in 'stable' signaling state are queued for
   * renegotiation once they become stable (via onsignalingstatechange).
   */
  async renegotiateAll(): Promise<void> {
    if (this.destroyed) return
    if (!this.localStream) return

    let renegotiated = 0
    let queued = 0

    for (const [remoteUserId, peer] of this.peerConnections) {
      // Skip peers that are mid-negotiation (signaling state must be 'stable')
      if (peer.pc.signalingState !== 'stable') {
        // Queue for renegotiation once signaling completes
        this.pendingRenegotiation.add(remoteUserId)
        queued++
        console.log('[WebRTC] Queuing renegotiation for', remoteUserId, '— signaling state:', peer.pc.signalingState)
        continue
      }

      // Only renegotiate if the audio transceiver has a track to send.
      const transceivers = peer.pc.getTransceivers()
      const audioTransceiver = transceivers.find(
        t => t.receiver?.track?.kind === 'audio' || t.sender?.track?.kind === 'audio'
      )
      if (!audioTransceiver) continue

      // Check that either we have a sender track OR the direction indicates
      // we intend to send.
      const hasSenderTrack = !!audioTransceiver.sender.track
      const wantsToSend = audioTransceiver.direction === 'sendrecv' || audioTransceiver.direction === 'sendonly'
      if (!hasSenderTrack && !wantsToSend) continue

      try {
        await this.sendRenegotiationOffer(remoteUserId, peer)
        renegotiated++
      } catch (err) {
        console.warn(classifySignalingError('Renegotiation', remoteUserId, err))
      }
    }

    if (renegotiated > 0 || queued > 0) {
      console.log('[WebRTC] RenegotiateAll complete:', renegotiated, 'renegotiated,', queued, 'queued for later')
    }
  }

  /**
   * Send a renegotiation offer to a specific peer.
   * Extracted from renegotiateAll() for reuse by the signaling state monitor.
   */
  private async sendRenegotiationOffer(remoteUserId: string, peer: PeerState): Promise<void> {
    const transceivers = peer.pc.getTransceivers()
    const audioTransceiver = transceivers.find(
      t => t.receiver?.track?.kind === 'audio' || t.sender?.track?.kind === 'audio'
    )
    if (!audioTransceiver) return

    const hasSenderTrack = !!audioTransceiver.sender.track
    const wantsToSend = audioTransceiver.direction === 'sendrecv' || audioTransceiver.direction === 'sendonly'
    if (!hasSenderTrack && !wantsToSend) return

    const offer = await peer.pc.createOffer()
    await peer.pc.setLocalDescription(offer)

    this.sendSignal(remoteUserId, {
      type: 'offer',
      sdp: peer.pc.localDescription!.sdp,
    })
    console.log('[WebRTC] Renegotiation offer sent to', remoteUserId)
  }

  /**
   * Ensure all peer connections have audio properly configured for sending.
   * Called on EVERY PTT press to handle cases where:
   *   - The eager init's renegotiateAll() was skipped (signaling not stable)
   *   - The initial offer went out as recvonly before mic was available
   *   - replaceTrack succeeded but no new offer was ever sent
   *
   * This method checks every peer's audio transceiver and, if needed,
   * sets the track + upgrades direction, then triggers renegotiation.
   */
  async ensureAudioSending(): Promise<void> {
    if (this.destroyed || !this.localStream) return

    const audioTrack = this.localStream.getAudioTracks()[0]
    if (!audioTrack) return

    let needsRenegotiation = false

    for (const [remoteUserId, peer] of this.peerConnections) {
      const transceivers = peer.pc.getTransceivers()
      const audioTransceiver = transceivers.find(
        t => t.receiver?.track?.kind === 'audio' || t.sender?.track?.kind === 'audio'
      )

      if (!audioTransceiver) {
        // No audio transceiver — this should never happen since
        // createPeerConnection() always adds one. Destroy and
        // recreate the connection rather than using addTrack()
        // which creates a NEW transceiver and shifts m-line order,
        // causing "order of m-lines doesn't match" errors.
        console.warn('[WebRTC] No audio transceiver for peer', remoteUserId, '— recreating connection')
        this.cleanupPeer(remoteUserId)
        this.onRemoteStreamRemoved?.(remoteUserId)
        this.createOffer(remoteUserId).catch(() => {})
        continue
      } else if (!audioTransceiver.sender.track) {
        // Audio transceiver exists but no sender track — set it
        try {
          await audioTransceiver.sender.replaceTrack(audioTrack)
          audioTransceiver.direction = 'sendrecv'
          needsRenegotiation = true
          console.log('[WebRTC] Replaced null sender track for peer', remoteUserId, '— renegotiation needed')
        } catch { /* replaceTrack failed */ }
      } else if (audioTransceiver.direction !== 'sendrecv' && audioTransceiver.direction !== 'sendonly') {
        // Direction is recvonly or inactive — upgrade to sendrecv
        audioTransceiver.direction = 'sendrecv'
        needsRenegotiation = true
        console.log('[WebRTC] Upgraded audio direction to sendrecv for peer', remoteUserId, '— renegotiation needed')
      }

      // ── Additional check: if ICE connection failed, restart it ──
      // This handles the case where STUN-only failed (no TURN was available
      // at connection time) but now we have TURN credentials.
      const iceState = peer.pc.iceConnectionState
      if (iceState === 'failed') {
        console.log('[WebRTC] ICE connection failed for', remoteUserId, '— restarting with updated ICE config')
        try {
          // Update the ICE configuration on the peer connection with
          // fresh TURN credentials, then restart ICE.
          const config = await fetchIceConfig()
          peer.pc.setConfiguration(config)
          const restartOffer = await peer.pc.createOffer({ iceRestart: true })
          await peer.pc.setLocalDescription(restartOffer)
          this.sendSignal(remoteUserId, {
            type: 'offer',
            sdp: peer.pc.localDescription!.sdp,
          })
          console.log('[WebRTC] ICE restart offer sent to', remoteUserId)
        } catch (err) {
          console.warn(classifySignalingError('ICE restart', remoteUserId, err))
        }
      }
    }

    if (needsRenegotiation) {
      console.log('[WebRTC] Audio configuration changed — renegotiating all peers')
      await this.renegotiateAll()
    }
  }

  // ── Offer creation ───────────────────────────────────────

  /**
   * Create a peer connection and send an offer to `targetUserId`.
   * Called when a new member joins the party (the joiner also calls this
   * for every existing member, or the existing members call it for the joiner).
   */
  async createOffer(targetUserId: string): Promise<void> {
    if (this.destroyed) return
    if (targetUserId === this.userId) return
    if (this.peerConnections.has(targetUserId)) return

    const peer = this.createPeerConnection(targetUserId)

    try {
      const offer = await peer.pc.createOffer()
      await peer.pc.setLocalDescription(offer)

      this.sendSignal(targetUserId, {
        type: 'offer',
        sdp: peer.pc.localDescription!.sdp,
      })
      console.log('[WebRTC] Offer sent to', targetUserId)
    } catch (err) {
      console.error(classifySignalingError('Create offer', targetUserId, err))
      this.cleanupPeer(targetUserId)
    }
  }

  // ── Signaling handlers ───────────────────────────────────

  /** Process an incoming offer from a remote user. */
  async handleOffer(fromUserId: string, sdp: string): Promise<void> {
    if (this.destroyed) return
    if (fromUserId === this.userId) return

    let peer = this.peerConnections.get(fromUserId)

    if (!peer) {
      peer = this.createPeerConnection(fromUserId)
    }

    try {
      // ── Polite peer pattern for WebRTC glare ──────────────
      // When both sides create offers simultaneously (glare),
      // both peer connections are in "have-local-offer" state.
      // setRemoteDescription(offer) fails in this state.
      //
      // Solution: the "polite" peer rolls back its local offer
      // and accepts the remote offer. The "impolite" peer ignores
      // the remote offer (the polite peer will handle it).
      // Deterministic rule: the user with the lexicographically
      // larger userId is the polite peer.
      const signalingState = peer.pc.signalingState
      if (signalingState === 'have-local-offer') {
        const isPolite = this.userId > fromUserId
        if (!isPolite) {
          // Impolite peer: ignore the incoming offer.
          // The polite peer will roll back and accept ours.
          return
        }
        // Polite peer: rollback our local offer and accept the remote one
        await peer.pc.setLocalDescription({ type: 'rollback' })
      }

      console.log('[WebRTC] Remote offer received from', fromUserId, 'signaling state:', signalingState)

      try {
        await peer.pc.setRemoteDescription({ type: 'offer', sdp })
      } catch (setRemoteErr) {
        // ── m-line order mismatch recovery ──────────────
        // setRemoteDescription(offer) fails when the remote's m-line order
        // doesn't match the previous offer/answer. This happens when
        // renegotiation changes the transceiver arrangement (e.g., addTrack
        // creates a new transceiver at the end, shifting all m-lines).
        // Recovery: destroy the peer connection entirely and create a fresh
        // one, then process the offer on the clean connection.
        const errMsg = setRemoteErr instanceof Error ? setRemoteErr.message : String(setRemoteErr)
        if (errMsg.includes('m-lines') || errMsg.includes('order of m-lines')) {
          console.warn('[WebRTC] m-line order mismatch from', fromUserId, '— destroying and recreating connection')
          this.cleanupPeer(fromUserId)
          this.onRemoteStreamRemoved?.(fromUserId)
          // Recreate with fresh peer connection and retry the offer
          peer = this.createPeerConnection(fromUserId)
          try {
            await peer.pc.setRemoteDescription({ type: 'offer', sdp })
            console.log('[WebRTC] m-line recovery successful for', fromUserId)
          } catch (retryErr) {
            console.error(classifySignalingError('m-line recovery', fromUserId, retryErr))
            return
          }
        } else {
          console.error(classifySignalingError('Offer processing', fromUserId, setRemoteErr))
          return
        }
      }

      // If we have a local mic track, ensure our answer includes it.
      // This handles the case where the remote sent a renegotiation
      // offer after we initialized our mic — our answer should reflect
      // that we can send audio too.
      if (this.localStream) {
        const audioTrack = this.localStream.getAudioTracks()[0]
        if (audioTrack) {
          const transceivers = peer.pc.getTransceivers()
          const audioTransceiver = transceivers.find(
            t => t.receiver?.track?.kind === 'audio' || t.sender?.track?.kind === 'audio'
          )
          if (audioTransceiver && !audioTransceiver.sender.track) {
            try {
              await audioTransceiver.sender.replaceTrack(audioTrack)
              audioTransceiver.direction = 'sendrecv'
            } catch {
              // replaceTrack failed — answer will have recvonly audio
            }
          } else if (audioTransceiver && audioTransceiver.sender.track) {
            if (audioTransceiver.direction !== 'sendrecv') {
              audioTransceiver.direction = 'sendrecv'
            }
          }
        }
      }

      // Apply any ICE candidates that arrived before the offer
      await this.flushPendingIce(fromUserId)

      const answer = await peer.pc.createAnswer()
      await peer.pc.setLocalDescription(answer)

      this.sendSignal(fromUserId, {
        type: 'answer',
        sdp: peer.pc.localDescription!.sdp,
      })
      console.log('[WebRTC] Answer sent to', fromUserId)
    } catch (err) {
      console.error(classifySignalingError('Offer processing (post-recovery)', fromUserId, err))
    }
  }

  /** Process an incoming answer from a remote user. */
  async handleAnswer(fromUserId: string, sdp: string): Promise<void> {
    if (this.destroyed) return
    if (fromUserId === this.userId) return

    const peer = this.peerConnections.get(fromUserId)
    if (!peer) return

    try {
      await peer.pc.setRemoteDescription({ type: 'answer', sdp })
      console.log('[WebRTC] Remote answer set from', fromUserId)

      // Apply any ICE candidates that arrived before the answer
      await this.flushPendingIce(fromUserId)
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      if (errMsg.includes('m-lines') || errMsg.includes('order of m-lines')) {
        console.warn('[WebRTC] m-line order mismatch on answer from', fromUserId, '— destroying connection')
        this.cleanupPeer(fromUserId)
        this.onRemoteStreamRemoved?.(fromUserId)
        // Our side needs to send a fresh offer — schedule it
        this.createOffer(fromUserId).catch(() => {})
      } else {
        console.error(classifySignalingError('Answer processing', fromUserId, err))
      }
    }
  }

  /** Process an incoming ICE candidate from a remote user. */
  async handleIceCandidate(fromUserId: string, candidate: RTCIceCandidateInit): Promise<void> {
    if (this.destroyed) return
    if (fromUserId === this.userId) return

    const peer = this.peerConnections.get(fromUserId)
    if (!peer) return

    // If remote description is not yet set, queue the candidate
    if (!peer.pc.remoteDescription) {
      peer.pendingIce.push(candidate)
      return
    }

    try {
      await peer.pc.addIceCandidate(new RTCIceCandidate(candidate))
    } catch {
      // Non-fatal — ICE candidate may be superseded
    }
  }

  // ── Peer lifecycle ───────────────────────────────────────

  /** Remove a single peer (when a member leaves the party). */
  removePeer(userId: string): void {
    this.cleanupPeer(userId)
  }

  /**
   * Clean up all peer connections that are in a failed or disconnected state.
   * Returns the list of user IDs whose connections were cleaned up.
   *
   * Called when the signaling channel reconnects (WebSocket recovered) to
   * ensure dead connections are destroyed and can be recreated with fresh
   * offers. Without this, createOffer() skips peers that already have
   * connections (even if those connections are permanently dead).
   */
  cleanupFailedPeers(): string[] {
    const failedPeers: string[] = []
    for (const [userId, peer] of this.peerConnections) {
      const iceState = peer.pc.iceConnectionState
      const connState = peer.pc.connectionState
      if (iceState === 'failed' || iceState === 'disconnected' || connState === 'failed' || connState === 'disconnected') {
        console.log('[WebRTC] Cleaning up dead peer connection for', userId, '(ICE:', iceState, ', conn:', connState, ')')
        this.cleanupPeer(userId)
        this.onRemoteStreamRemoved?.(userId)
        failedPeers.push(userId)
      }
    }
    return failedPeers
  }

  /** Destroy all connections and release all resources. */
  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true

    // Close all peer connections
    for (const userId of this.peerConnections.keys()) {
      this.cleanupPeer(userId)
    }

    // Release microphone
    if (this.localStream) {
      for (const track of this.localStream.getTracks()) {
        track.stop()
      }
      this.localStream = null
    }

    this.signalSender = null
    this.onRemoteStream = null
    this.onRemoteStreamRemoved = null
  }

  // ── Private helpers ──────────────────────────────────────

  /**
   * Create an RTCPeerConnection for a remote user, wire up event
   * handlers, and add local tracks if the microphone is available.
   */
  private createPeerConnection(remoteUserId: string): PeerState {
    const pc = new RTCPeerConnection(this.iceConfig)
    const peer: PeerState = { pc, pendingIce: [], iceRestartAttempts: 0 }

    this.peerConnections.set(remoteUserId, peer)

    // Always add an audio transceiver so the SDP always contains an audio
    // m-line — even before the mic is initialized. Without this, peers
    // created before init() would have no audio section in their SDP,
    // and renegotiation later may silently fail (no ontrack fires on the
    // remote side, so no audio element is ever created → no sound).
    //
    // If the mic is already available, use 'sendrecv' direction so the
    // initial offer includes audio. Otherwise use 'recvonly' — the
    // direction will be upgraded when init() completes.
    const direction = this.localStream ? 'sendrecv' : 'recvonly'
    pc.addTransceiver('audio', { direction })

    // If the mic is already available, set the track on the transceiver
    // sender and upgrade direction to sendrecv.
    if (this.localStream) {
      const audioTrack = this.localStream.getAudioTracks()[0]
      if (audioTrack) {
        const transceivers = pc.getTransceivers()
        const audioTransceiver = transceivers.find(t => t.receiver?.track?.kind === 'audio')
        if (audioTransceiver) {
          audioTransceiver.sender.replaceTrack(audioTrack)
          audioTransceiver.direction = 'sendrecv'
        } else {
          pc.addTrack(audioTrack, this.localStream)
        }
      }
    }

    // ── ICE candidate → signal to remote ─────────────────
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.sendSignal(remoteUserId, {
          type: 'ice-candidate',
          candidate: event.candidate.toJSON(),
        })
      }
    }

    // ── Remote track → auto-play audio ───────────────────
    pc.ontrack = (event) => {
      // When using addTransceiver + replaceTrack (instead of addTrack(track, stream)),
      // event.streams is an empty array because no MediaStream was associated
      // with the transceiver. We must create a synthetic MediaStream from
      // the received track to enable audio playback.
      let stream = event.streams[0]
      if (!stream) {
        stream = new MediaStream([event.track])
        console.log('[WebRTC] Created synthetic MediaStream for track from', remoteUserId, '(transceiver had no stream)')
      }

      console.log('[WebRTC] Remote track received from', remoteUserId, 'kind:', event.track.kind, 'streams:', event.streams.length)

      // Fire callback so the UI can show voice indicators etc.
      this.onRemoteStream?.(remoteUserId, stream)

      // Auto-play the remote audio via an HTMLAudioElement
      this.playRemoteAudio(remoteUserId, stream)
    }

    // ── Connection state monitoring ──────────────────────
    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState
      console.log('[WebRTC] ICE state for', remoteUserId, ':', state)
      if (state === 'connected' || state === 'completed') {
        // ICE connection established — audio should flow if tracks are present
        console.log('[WebRTC] Connection established with', remoteUserId)
        // Reset restart counter on successful connection
        peer.iceRestartAttempts = 0
      }
      if (state === 'disconnected') {
        // Disconnected — ICE may recover on its own, but don't wait forever.
        // If still disconnected after 10 seconds, force an ICE restart.
        // This handles the case where ICE gets stuck in 'disconnected'
        // and never transitions to 'failed' or back to 'connected'.
        console.warn('[WebRTC] ICE disconnected from', remoteUserId, '— waiting 10s before forcing restart')
        setTimeout(() => {
          if (this.destroyed) return
          // Check if this peer was cleaned up while we waited
          if (!this.peerConnections.has(remoteUserId)) return
          const currentState = pc.iceConnectionState
          if (currentState === 'disconnected') {
            console.warn('[WebRTC] ICE still disconnected after 10s for', remoteUserId, '— forcing ICE restart')
            this.restartIceForPeer(remoteUserId, peer)
          }
        }, 10_000)
      }
      if (state === 'failed') {
        // ICE failed — attempt to restart ICE with fresh TURN credentials
        console.error('[WebRTC] ICE connection failed with', remoteUserId, '— attempting ICE restart')
        this.restartIceForPeer(remoteUserId, peer)
      }
    }

    // ── Peer connection state monitoring ──────────────────
    pc.onconnectionstatechange = () => {
      const state = pc.connectionState
      console.log('[WebRTC] Connection state for', remoteUserId, ':', state)
      if (state === 'failed') {
        console.error('[WebRTC] Peer connection failed with', remoteUserId)
        this.restartIceForPeer(remoteUserId, peer)
      }
    }

    // ── Signaling state monitoring for renegotiation ──────
    // When we need to renegotiate (e.g., to add audio tracks after mic init),
    // the peer must be in 'stable' signaling state. If it's not stable yet
    // (mid initial offer/answer exchange), we queue the renegotiation and
    // trigger it once signaling completes.
    pc.onsignalingstatechange = () => {
      const state = pc.signalingState
      if (state === 'stable' && this.pendingRenegotiation.has(remoteUserId)) {
        this.pendingRenegotiation.delete(remoteUserId)
        console.log('[WebRTC] Signaling reached stable for', remoteUserId, '— executing queued renegotiation')
        // Use setTimeout to avoid re-entrancy issues with signaling events
        setTimeout(() => {
          if (this.destroyed || !this.localStream) return
          this.sendRenegotiationOffer(remoteUserId, peer).catch((err) => {
            console.warn(classifySignalingError('Queued renegotiation', remoteUserId, err))
          })
        }, 100)
      }
    }

    return peer
  }

  /**
   * Restart ICE for a failed peer connection.
   * First updates the ICE configuration with fresh TURN credentials,
   * then sends an ICE restart offer.
   *
   * If ICE restart fails too many times, destroys the peer connection
   * entirely and creates a fresh one.
   */
  private async restartIceForPeer(remoteUserId: string, peer: PeerState): Promise<void> {
    peer.iceRestartAttempts++

    // After 3 failed ICE restarts, destroy and recreate the connection entirely.
    // ICE restart reuses the same RTCPeerConnection which may be in a
    // permanently broken state. Creating a fresh PC forces a clean slate.
    if (peer.iceRestartAttempts > 3) {
      console.warn('[WebRTC] Too many ICE restart failures for', remoteUserId, '— destroying and recreating connection')
      this.cleanupPeer(remoteUserId)
      this.onRemoteStreamRemoved?.(remoteUserId)
      // Create a fresh peer connection and offer
      await this.createOffer(remoteUserId)
      return
    }

    try {
      // Refresh ICE config in case TURN credentials are now available
      const freshConfig = await fetchIceConfig()
      try {
        peer.pc.setConfiguration(freshConfig)
      } catch {
        // setConfiguration may fail if the PC is in a bad state — continue anyway
      }

      const offer = await peer.pc.createOffer({ iceRestart: true })
      await peer.pc.setLocalDescription(offer)
      this.sendSignal(remoteUserId, {
        type: 'offer',
        sdp: peer.pc.localDescription!.sdp,
      })
      console.log('[WebRTC] ICE restart offer sent to', remoteUserId, '(attempt', peer.iceRestartAttempts, ')')
    } catch (err) {
      console.error(classifySignalingError('ICE restart', remoteUserId, err), '(attempt', peer.iceRestartAttempts, ')')
      // Destroy and recreate the peer connection (same as >3 threshold path).
      // Don't just cleanupPeer with no recovery — that permanently kills voice.
      this.cleanupPeer(remoteUserId)
      this.onRemoteStreamRemoved?.(remoteUserId)
      try {
        await this.createOffer(remoteUserId)
      } catch (recreateErr) {
        console.error('[WebRTC] Failed to recreate peer after ICE restart failure for', remoteUserId, recreateErr)
      }
    }
  }

  /**
   * Add local audio tracks to peer connections that were created
   * before init() completed (i.e. before the mic stream was available).
   *
   * MUST be called after init() acquires the mic stream. Replaces the
   * null sender track on existing recvonly transceivers with the real
   * audio track and upgrades the direction to sendrecv, enabling
   * audio transmission in the next renegotiation.
   */
  private async addLocalTracksToExistingPeers(): Promise<void> {
    if (!this.localStream) return
    const audioTrack = this.localStream.getAudioTracks()[0]
    if (!audioTrack) return

    for (const [remoteUserId, peer] of this.peerConnections) {
      const transceivers = peer.pc.getTransceivers()
      const audioTransceiver = transceivers.find(
        t => t.receiver?.track?.kind === 'audio' || t.sender?.track?.kind === 'audio'
      )

      if (audioTransceiver && !audioTransceiver.sender.track) {
        try {
          await audioTransceiver.sender.replaceTrack(audioTrack)
          audioTransceiver.direction = 'sendrecv'
          console.log('[WebRTC] Audio track added to existing peer', remoteUserId, '— direction upgraded to sendrecv')
        } catch {
          // replaceTrack failed — do NOT use addTrack() fallback as it
          // creates a new transceiver that shifts m-line order
          console.warn('[WebRTC] replaceTrack failed for peer', remoteUserId)
        }
      } else if (audioTransceiver && audioTransceiver.sender.track) {
        // Track already set — just ensure direction is sendrecv
        if (audioTransceiver.direction !== 'sendrecv') {
          audioTransceiver.direction = 'sendrecv'
        }
      } else if (!audioTransceiver) {
        // Should never happen — createPeerConnection always adds an audio
        // transceiver. Skip addTrack() to avoid m-line order mismatch.
        console.warn('[WebRTC] No audio transceiver for peer', remoteUserId, 'in addLocalTracksToExistingPeers')
      }

      // Also update the ICE configuration on existing peer connections
      // in case TURN credentials are now available (they weren't when
      // the peer was created before init() fetched them).
      try {
        if (this.iceConfig !== STUN_ONLY_CONFIG) {
          peer.pc.setConfiguration(this.iceConfig)
        }
      } catch {
        // setConfiguration may fail — non-critical
      }
    }
  }

  /**
   * Apply all queued ICE candidates for a peer after its remote
   * description has been set.
   */
  private async flushPendingIce(userId: string): Promise<void> {
    const peer = this.peerConnections.get(userId)
    if (!peer || peer.pendingIce.length === 0) return

    const candidates = peer.pendingIce.splice(0)
    for (const candidate of candidates) {
      try {
        await peer.pc.addIceCandidate(new RTCIceCandidate(candidate))
      } catch {
        // Non-fatal — continue flushing remaining candidates
      }
    }
  }

  /**
   * Create or reuse an HTMLAudioElement to play a remote stream.
   * This prevents audio feedback by ensuring we never play our
   * own stream (only remote userIds reach this method).
   *
   * The audio element MUST be appended to the DOM (hidden) because
   * browsers block autoplay on detached elements. We also call
   * play() explicitly with error handling for autoplay policies.
   */
  private playRemoteAudio(userId: string, stream: MediaStream): void {
    // Clean up any existing audio element for this user
    this.stopRemoteAudio(userId)

    const audio = document.createElement('audio')
    audio.srcObject = stream
    audio.autoplay = true
    audio.volume = 1
    // Hidden attribute keeps element in DOM (required for playback)
    // without affecting layout or visibility
    audio.setAttribute('hidden', '')

    // Append to DOM — browsers block autoplay on detached audio elements.
    // The element is hidden so it doesn't affect layout.
    document.body.appendChild(audio)

    this.audioElements.set(userId, audio)

    // Explicit play() call — autoplay attribute alone is unreliable.
    // Catch autoplay policy rejections (browser may require user gesture).
    audio.play().then(() => {
      console.log('[WebRTC] Remote audio playing for', userId)
    }).catch((err) => {
      // Autoplay blocked — will retry on next PTT press (user gesture).
      // See retryPausedAudio() which is called from sendPttStart and
      // also when a remote ptt-start broadcast is received.
      console.warn('[WebRTC] Autoplay blocked for', userId, '— will retry on user gesture:', err?.name || err)
    })
  }

  /**
   * Retry playing any paused remote audio elements.
   * Called during PTT activation (which is a user gesture) to work around
   * browser autoplay policies that block audio.play() without user interaction.
   *
   * Also called when a remote PTT start is received — while this is NOT a
   * user gesture on the receiver's side, some browsers allow play() in
   * certain contexts. If still blocked, the next local PTT press will
   * definitively unlock it.
   */
  retryPausedAudio(): void {
    let retried = 0
    for (const [userId, audio] of this.audioElements) {
      if (audio.paused && audio.srcObject) {
        retried++
        audio.play().then(() => {
          console.log('[WebRTC] Retry: remote audio now playing for', userId)
        }).catch(() => {
          // Still blocked — will retry on next local PTT press
          // (which IS a user gesture and will definitely work)
        })
      }
    }
    if (retried > 0) {
      console.log('[WebRTC] Retried', retried, 'paused remote audio element(s)')
    }
  }

  /** Stop and remove the audio element for a remote user. */
  private stopRemoteAudio(userId: string): void {
    const audio = this.audioElements.get(userId)
    if (audio) {
      audio.srcObject = null
      audio.pause()
      // Remove from DOM (was appended for playback)
      if (audio.parentNode) {
        audio.parentNode.removeChild(audio)
      }
      this.audioElements.delete(userId)
    }
  }

  /**
   * Clean up all resources associated with a peer:
   * close the RTCPeerConnection, stop audio playback, remove state.
   */
  private cleanupPeer(userId: string): void {
    const peer = this.peerConnections.get(userId)
    if (peer) {
      peer.pc.onicecandidate = null
      peer.pc.ontrack = null
      peer.pc.oniceconnectionstatechange = null
      peer.pc.onconnectionstatechange = null
      peer.pc.onsignalingstatechange = null
      peer.pc.close()
      this.peerConnections.delete(userId)
    }

    this.pendingRenegotiation.delete(userId)
    this.stopRemoteAudio(userId)
  }

  /** Send a signaling message to a remote user via the configured sender. */
  private sendSignal(targetUserId: string, signal: WebRtcSignal): void {
    this.signalSender?.(targetUserId, signal)
  }
}
