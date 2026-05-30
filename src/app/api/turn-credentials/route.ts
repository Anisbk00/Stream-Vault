import { NextResponse } from 'next/server'

/**
 * StreamVault — ICE Server Configuration API
 *
 * Returns STUN + TURN servers for WebRTC NAT traversal.
 *
 * CRITICAL: STUN-only works on the same LAN but FAILS across different
 * NATs (the common case for remote users). TURN relay servers are
 * required for audio to flow when both peers are behind NAT.
 *
 * We use the Open Relay Project for free TURN credentials.
 * These are fetched dynamically so they don't expire.
 * The client caches them for 4 hours.
 */

// Open Relay Project — free TURN server with dynamic credentials
const OPEN_RELAY_URL = 'https://openrelay.metered.ca/api/v1/turn/credentials?apiKey='

// Fallback hardcoded TURN credentials (from Open Relay free tier)
// These rotate periodically and may expire — the dynamic fetch is preferred.
const FALLBACK_TURN_SERVERS = [
  {
    urls: 'turn:a.relay.metered.ca:443',
    username: 'e8dd40493c68fd6b89b3a4a7',
    credential: '5FKF+pDtzP1K2PKB',
  },
  {
    urls: 'turn:a.relay.metered.ca:443?transport=tcp',
    username: 'e8dd40493c68fd6b89b3a4a7',
    credential: '5FKF+pDtzP1K2PKB',
  },
]

async function fetchOpenRelayCredentials(): Promise<typeof FALLBACK_TURN_SERVERS | null> {
  try {
    // Open Relay provides a free tier API key for testing
    // If you have a Metered.ca API key, set it as OPEN_RELAY_API_KEY env var
    const apiKey = process.env.OPEN_RELAY_API_KEY || ''
    const url = apiKey
      ? `${OPEN_RELAY_URL}${apiKey}`
      : 'https://openrelay.metered.ca/api/v1/turn/credentials'

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5000)

    const res = await fetch(url, { signal: controller.signal })
    clearTimeout(timeout)

    if (!res.ok) return null

    const data = await res.json()
    if (data && Array.isArray(data.iceServers) && data.iceServers.length > 0) {
      return data.iceServers
    }
  } catch {
    // Dynamic fetch failed — use fallback
  }
  return null
}

export async function GET() {
  // Try dynamic TURN credentials first
  const dynamicServers = await fetchOpenRelayCredentials()

  const iceServers = [
    // STUN servers (always included — lightweight, no relay cost)
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
    // Additional STUN for redundancy
    { urls: 'stun:stun01.sipphone.com' },
    { urls: 'stun:stun.ekiga.net' },
  ]

  // Add TURN servers (either dynamic or fallback)
  if (dynamicServers && dynamicServers.length > 0) {
    iceServers.push(...dynamicServers)
  } else {
    iceServers.push(...FALLBACK_TURN_SERVERS)
  }

  return NextResponse.json({ iceServers })
}
