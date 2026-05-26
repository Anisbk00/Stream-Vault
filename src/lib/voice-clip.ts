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

  /** The MIME type used for the last recording (needed for playback info) */
  get mimeType(): string { return this._mimeType }

  /**
   * Start recording audio from the microphone.
   * On iOS, this briefly ducks movie audio (unavoidable OS behavior).
   * The ducking lasts only for the duration of the recording.
   */
  async startRecording(): Promise<boolean> {
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
        resolve(null)
        return
      }

      const duration = Date.now() - this.startTime

      this.mediaRecorder.onstop = () => {
        // Release mic IMMEDIATELY — this returns iOS AVAudioSession to .playback
        this.stream?.getTracks().forEach((t) => t.stop())
        this.stream = null
        this.mediaRecorder = null

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

  /** Force-abort recording without returning data (cleanup on error/disconnect) */
  abort(): void {
    try {
      if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
        this.mediaRecorder.stop()
      }
    } catch { /* already stopped */ }
    this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = null
    this.mediaRecorder = null
    this.chunks = []
  }
}

// ── Voice Clip Playback ─────────────────────────────────────

/** Currently playing audio elements — keyed by userId for cleanup */
const _activeClips = new Map<string, HTMLAudioElement>()

/**
 * Play a received voice clip from another user.
 * Returns a cleanup function that stops playback and releases resources.
 */
export function playVoiceClip(
  fromUserId: string,
  base64Audio: string,
  mimeType: string,
  onEnded: () => void,
): void {
  // Stop any currently playing clip from this user
  stopVoiceClip(fromUserId)

  try {
    // Decode base64 → binary → Blob → Object URL
    const binaryString = atob(base64Audio)
    const bytes = new Uint8Array(binaryString.length)
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i)
    }
    const blob = new Blob([bytes], { type: mimeType })
    const url = URL.createObjectURL(blob)

    const audio = new Audio(url)
    _activeClips.set(fromUserId, audio)

    audio.onended = () => {
      cleanup()
      onEnded()
    }
    audio.onerror = () => {
      cleanup()
      onEnded()
    }

    function cleanup() {
      _activeClips.delete(fromUserId)
      audio.onended = null
      audio.onerror = null
      try { URL.revokeObjectURL(url) } catch { /* already revoked */ }
    }

    // Play with user gesture context from PTT button (should work on iOS)
    audio.play().catch(() => {
      cleanup()
      onEnded()
    })
  } catch {
    onEnded()
  }
}

/** Stop playing a voice clip from a specific user */
export function stopVoiceClip(userId: string): void {
  const audio = _activeClips.get(userId)
  if (audio) {
    audio.onended = null
    audio.onerror = null
    audio.pause()
    audio.src = ''
    _activeClips.delete(userId)
  }
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
