/**
 * StreamVault — Voice Clip Recorder for iOS Watch Party PTT
 *
 * On iOS WKWebView, getUserMedia() forces AVAudioSession into .playAndRecord
 * mode, which dramatically ducks all other audio output (movie audio in the
 * iframe). Even after track.stop(), open RTCPeerConnection objects with audio
 * transceivers keep the session alive — this is an OS-level behavior with no
 * Web API workaround.
 *
 * This module replaces real-time WebRTC voice on iOS with record-and-forward
 * voice clips (same pattern as iMessage voice messages, WhatsApp voice notes).
 * The mic is only active during recording — after PTT release, the mic is
 * freed immediately and movie audio returns to full volume. The recorded clip
 * is sent via the existing Supabase broadcast channel and played on receivers.
 *
 * Non-iOS platforms continue to use real-time WebRTC voice (unchanged).
 *
 * PLAYBACK: On iOS, HTMLAudioElement.play() requires a user gesture context.
 * Voice clips arrive asynchronously via Supabase Broadcast, so there is NO
 * gesture context — play() always rejects with NotAllowedError. To fix this,
 * we use the Web Audio API (AudioContext) for playback on iOS. An AudioContext
 * created during a user gesture (the local PTT press) stays "warm" and can
 * decode+play audio without gesture context for the entire party session.
 */

// ── iOS Detection ──────────────────────────────────────────

function isIOSDevice(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
}

export { isIOSDevice }

// ── Types ───────────────────────────────────────────────────

/** Event broadcast via Supabase channel when a voice clip is sent */
export interface WpVoiceClipEvent {
  t: 'voice-clip'
  fromUserId: string
  displayName: string
  audio: string // base64-encoded audio data
  mimeType: string // e.g. 'audio/mp4', 'audio/webm;codecs=opus'
  duration: number // recording duration in ms (for speaking indicator timing)
}

// ── Shared AudioContext for iOS playback ────────────────────

/**
 * Module-level AudioContext for iOS voice clip playback.
 * Must be created/resumed during a user gesture (PTT press) to work
 * without gesture context for subsequent clip playbacks.
 */
let _audioCtx: AudioContext | null = null

/** Maximum voice clip base64 size (64KB — stays within Supabase Realtime limits on free tier) */
const MAX_CLIP_BASE64_SIZE = 64 * 1024
/** Maximum recording duration in ms (5s — keeps clips small for broadcast transport) */
const MAX_RECORDING_DURATION_MS = 5_000

/**
 * Initialize or resume the AudioContext. Call this during a user gesture
 * (e.g., PTT press) so that subsequent playVoiceClip calls work on iOS.
 */
export function initAudioContext(): void {
  try {
    if (!_audioCtx) {
      _audioCtx = new AudioContext()
    }
    if (_audioCtx.state === 'suspended') {
      _audioCtx.resume()
    }
  } catch {
    // AudioContext not supported — fallback to HTMLAudioElement
  }
}

/**
 * Clean up the shared AudioContext. Call on party leave.
 */
export function cleanupAudioContext(): void {
  try {
    if (_audioCtx) {
      _audioCtx.close()
      _audioCtx = null
    }
  } catch { /* already closed */ }
}

// ── Voice Clip Recorder ─────────────────────────────────────

/**
 * Records short audio clips using the MediaRecorder API.
 * Designed for push-to-talk: start on press, stop on release.
 * Mic is released immediately on stop — no lingering audio session.
 */
export class VoiceClipRecorder {
  private mediaRecorder: MediaRecorder | null = null
  private chunks: Blob[] = []
  private stream: MediaStream | null = null
  private startTime = 0
  private _mimeType = ''
  private _recording = false

  /** The MIME type used for the last recording (needed for playback info) */
  get mimeType(): string { return this._mimeType }

  /**
   * Start recording audio from the microphone.
   * On iOS, this briefly ducks movie audio (unavoidable OS behavior).
   * The ducking lasts only for the duration of the recording.
   */
  async startRecording(): Promise<boolean> {
    // Guard against double-start — abort any existing recording first
    if (this._recording) {
      this.abort()
    }

    try {
      // Use conservative constraints to minimize iOS audio session impact:
      // - echoCancellation: false — prevents "voice chat" audio routing
      // - noiseSuppression: true — cleaner voice
      // - autoGainControl: omitted — browser default (needed for usable signal on iOS)
      const constraints: MediaTrackConstraints = {
        echoCancellation: false,
        noiseSuppression: true,
      }

      this.stream = await navigator.mediaDevices.getUserMedia({ audio: constraints })
      this.chunks = []

      // Pick the best supported MIME type
      const types = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/mp4',
        'audio/mpeg',
        '',
      ]

      let mimeType = ''
      for (const type of types) {
        if (!type || MediaRecorder.isTypeSupported(type)) {
          mimeType = type
          break
        }
      }

      this.mediaRecorder = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined)
      this._mimeType = this.mediaRecorder.mimeType || mimeType || 'audio/webm'

      this.mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          this.chunks.push(e.data)
        }
      }

      // Collect data every 100ms for low-latency stop
      this.mediaRecorder.start(100)
      this.startTime = Date.now()
      this._recording = true

      // Auto-stop after max duration to prevent oversized clips
      // that would exceed Supabase Realtime message size limits
      this._maxDurationTimer = setTimeout(() => {
        if (this._recording) {
          this.stopRecording()
        }
      }, MAX_RECORDING_DURATION_MS)

      return true
    } catch {
      return false
    }
  }

  /**
   * Stop recording and return the audio blob.
   * Releases the microphone immediately — iOS audio session returns to normal.
   */
  async stopRecording(): Promise<{ blob: Blob; duration: number } | null> {
    return new Promise((resolve) => {
      if (!this.mediaRecorder || this.mediaRecorder.state === 'inactive') {
        this._recording = false
        resolve(null)
        return
      }

      const duration = Date.now() - this.startTime

      this.mediaRecorder.onstop = () => {
        // Clear max duration timer (if stop was triggered by user, not auto-stop)
        if (this._maxDurationTimer) {
          clearTimeout(this._maxDurationTimer)
          this._maxDurationTimer = null
        }
        // Release mic IMMEDIATELY — this returns iOS AVAudioSession to .playback
        this.stream?.getTracks().forEach((t) => t.stop())
        this.stream = null
        this.mediaRecorder = null
        this._recording = false

        if (this.chunks.length === 0) {
          resolve(null)
          return
        }

        const blob = new Blob(this.chunks, { type: this._mimeType })
        this.chunks = []
        resolve({ blob, duration })
      }

      // Request any remaining data before stopping
      if (this.mediaRecorder.state === 'recording') {
        this.mediaRecorder.requestData()
        this.mediaRecorder.stop()
      } else {
        this.mediaRecorder.stop()
      }
    })
  }

  /** Max duration timer handle */
  private _maxDurationTimer: ReturnType<typeof setTimeout> | null = null

  /** Force-abort recording without returning data (cleanup on error/disconnect) */
  abort(): void {
    try {
      if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
        this.mediaRecorder.stop()
      }
    } catch { /* already stopped */ }
    if (this._maxDurationTimer) {
      clearTimeout(this._maxDurationTimer)
      this._maxDurationTimer = null
    }
    this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = null
    this.mediaRecorder = null
    this._recording = false
    this.chunks = []
  }
}

// ── Voice Clip Playback ─────────────────────────────────────

/** Currently playing audio elements — keyed by userId for cleanup */
const _activeClips = new Map<string, { audio?: HTMLAudioElement; source?: AudioBufferSourceNode; objectUrl?: string }>()

/**
 * Play a received voice clip from another user.
 * Uses Web Audio API on iOS (AudioContext created during PTT gesture stays warm).
 * Falls back to HTMLAudioElement on other platforms.
 */
export function playVoiceClip(
  fromUserId: string,
  base64Audio: string,
  mimeType: string,
  onEnded: () => void,
): void {
  // Validate clip size
  if (!base64Audio || base64Audio.length > MAX_CLIP_BASE64_SIZE) {
    onEnded()
    return
  }

  // Stop any currently playing clip from this user
  stopVoiceClip(fromUserId)

  try {
    // Decode base64 → binary → Blob
    const binaryString = atob(base64Audio)
    const bytes = new Uint8Array(binaryString.length)
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i)
    }
    const blob = new Blob([bytes], { type: mimeType })

    // On iOS, use Web Audio API for playback (HTMLAudioElement requires gesture context)
    if (isIOSDevice() && _audioCtx) {
      playClipWithAudioContext(fromUserId, blob, onEnded)
    } else {
      playClipWithAudioElement(fromUserId, blob, onEnded)
    }
  } catch {
    onEnded()
  }
}

/**
 * Play a clip using the Web Audio API — works on iOS without gesture context
 * as long as the AudioContext was created/resumed during a prior user gesture.
 */
function playClipWithAudioContext(
  fromUserId: string,
  blob: Blob,
  onEnded: () => void,
): void {
  if (!_audioCtx) {
    // Fallback to AudioElement if context is somehow null
    playClipWithAudioElement(fromUserId, blob, onEnded)
    return
  }

  const reader = new FileReader()
  reader.onload = () => {
    if (!_audioCtx || !reader.result) {
      onEnded()
      return
    }

    _audioCtx.decodeAudioData(reader.result as ArrayBuffer, (audioBuffer) => {
      if (!_audioCtx) {
        onEnded()
        return
      }

      const source = _audioCtx.createBufferSource()
      source.buffer = audioBuffer
      source.connect(_audioCtx.destination)

      const entry = { source, objectUrl: undefined as string | undefined }
      _activeClips.set(fromUserId, entry)

      source.onended = () => {
        _activeClips.delete(fromUserId)
        onEnded()
      }

      source.start()
    }, () => {
      // Decode failed — fallback to AudioElement
      playClipWithAudioElement(fromUserId, blob, onEnded)
    })
  }
  reader.onerror = () => onEnded()
  reader.readAsArrayBuffer(blob)
}

/**
 * Play a clip using HTMLAudioElement — standard path for non-iOS platforms.
 */
function playClipWithAudioElement(
  fromUserId: string,
  blob: Blob,
  onEnded: () => void,
): void {
  const url = URL.createObjectURL(blob)
  const audio = new Audio(url)
  const entry = { audio, objectUrl: url }
  _activeClips.set(fromUserId, entry)

  const cleanup = () => {
    _activeClips.delete(fromUserId)
    audio.onended = null
    audio.onerror = null
    try { URL.revokeObjectURL(url) } catch { /* already revoked */ }
  }

  audio.onended = () => {
    cleanup()
    onEnded()
  }
  audio.onerror = () => {
    cleanup()
    onEnded()
  }

  audio.play().catch(() => {
    cleanup()
    onEnded()
  })
}

/** Stop playing a voice clip from a specific user */
export function stopVoiceClip(userId: string): void {
  const entry = _activeClips.get(userId)
  if (!entry) return

  if (entry.source) {
    // Web Audio API playback
    try { entry.source.stop() } catch { /* already stopped */ }
    try { entry.source.disconnect() } catch { /* already disconnected' */ }
  }
  if (entry.audio) {
    // HTMLAudioElement playback
    entry.audio.onended = null
    entry.audio.onerror = null
    entry.audio.pause()
    entry.audio.src = ''
  }
  // Revoke Object URL to prevent memory leak
  if (entry.objectUrl) {
    try { URL.revokeObjectURL(entry.objectUrl) } catch { /* already revoked */ }
  }
  _activeClips.delete(userId)
}

/** Stop all playing voice clips (cleanup on party leave) */
export function stopAllVoiceClips(): void {
  for (const [userId] of _activeClips) {
    stopVoiceClip(userId)
  }
}

/**
 * Encode an audio Blob to base64 string for broadcast.
 * Returns a Promise that resolves to the base64 string.
 */
export function encodeClipToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = reader.result as string
      // dataUrl format: "data:<mimeType>;base64,<base64Data>"
      const base64 = dataUrl.split(',')[1]
      if (base64) resolve(base64)
      else reject(new Error('Failed to encode audio clip'))
    }
    reader.onerror = () => reject(new Error('FileReader failed'))
    reader.readAsDataURL(blob)
  })
}
