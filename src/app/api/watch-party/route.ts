/**
 * StreamVault — Watch Party API Route
 *
 * Server-side handler for ALL watch party DB operations.
 * Uses the Supabase service role key to bypass RLS entirely.
 * Client-side Supabase is retained only for Realtime channels + SELECT reads.
 *
 * Architecture decision: RLS policies on watch_parties / watch_party_members
 * may be misconfigured or not applied. The service role key bypasses RLS,
 * making the invite flow reliable regardless of Supabase dashboard state.
 * Auth verification is done server-side by validating the JWT token.
 */

import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/types/supabase'
import { rateLimit, rateLimitResponse, getClientIp, RATE_LIMITS } from '@/lib/rate-limit'

// ── Supabase clients ──────────────────────────────────────

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || ''
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || ''
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || ''

const supabaseAvailable = !!(supabaseUrl && supabaseAnonKey)

/** Module-level anon client for JWT verification only */
const supabase = supabaseAvailable
  ? createClient<Database>(supabaseUrl, supabaseAnonKey)
  : null

/** Service-role client — bypasses RLS for all operations */
const admin = supabaseAvailable && supabaseServiceKey
  ? createClient<Database>(supabaseUrl, supabaseServiceKey)
  : null

// ── Input validation helpers ─────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_STRING_LENGTH = 500
const MAX_CONTENT_TITLE_LENGTH = 200
const MAX_PARTY_MEMBERS = 20

function validateUuid(v: unknown, field: string): string | undefined {
  if (typeof v !== 'string' || !UUID_RE.test(v)) return undefined
  return v
}

function validateString(v: unknown, maxLength = MAX_STRING_LENGTH): string | undefined {
  if (typeof v !== 'string' || v.length === 0 || v.length > maxLength) return undefined
  return v
}

function validateFiniteNumber(v: unknown, min = 0, max = 1_000_000): number | undefined {
  if (typeof v !== 'number' || !isFinite(v) || v < min || v > max) return undefined
  return v
}

function validateMediaType(v: unknown): 'movie' | 'tv' | undefined {
  if (v === 'movie' || v === 'tv') return v
  return undefined
}

function validateNullableNumber(v: unknown, min = 0, max = 100_000): number | null | undefined {
  if (v === null || v === undefined) return null
  if (typeof v === 'number' && isFinite(v) && v >= min && v <= max) return v
  return undefined
}

// ── Auth + Membership helpers ────────────────────────────

async function verifyAuth(request: Request, body?: { token?: string }): Promise<{ userId: string; email: string } | null> {
  const authHeader = request.headers.get('Authorization')
  let token = authHeader?.startsWith('Bearer ') ? authHeader.replace('Bearer ', '') : null

  if (!token && body?.token) {
    token = body.token
  }

  if (!token) return null
  if (!supabase) return null

  const { data: { user }, error } = await supabase.auth.getUser(token)
  if (error || !user) return null

  return { userId: user.id, email: user.email ?? '' }
}

/** Verify that the user is a joined member of the party. Returns party row or error response. */
async function verifyMembership(userId: string, partyId: string): Promise<{ party: Record<string, unknown> } | NextResponse> {
  const { data: party, error: partyError } = await admin!
    .from('watch_parties')
    .select('*')
    .eq('id', partyId)
    .maybeSingle()

  if (partyError || !party) {
    return NextResponse.json({ error: 'Party not found' }, { status: 404 })
  }

  if ((party as Record<string, unknown>).status === 'ended') {
    return NextResponse.json({ error: 'Party has ended' }, { status: 410 })
  }

  const { data: membership } = await admin!
    .from('watch_party_members')
    .select('status')
    .eq('party_id', partyId)
    .eq('user_id', userId)
    .eq('status', 'joined')
    .maybeSingle()

  if (!membership) {
    return NextResponse.json({ error: 'You are not a member of this party' }, { status: 403 })
  }

  return { party }
}

/** Verify that the user is the host of the party. Returns party row or error response. */
async function verifyHost(userId: string, partyId: string): Promise<{ party: Record<string, unknown> } | NextResponse> {
  const { data: party, error: partyError } = await admin!
    .from('watch_parties')
    .select('*')
    .eq('id', partyId)
    .maybeSingle()

  if (partyError || !party) {
    return NextResponse.json({ error: 'Party not found' }, { status: 404 })
  }

  if ((party as Record<string, unknown>).host_id !== userId) {
    return NextResponse.json({ error: 'Only the host can perform this action' }, { status: 403 })
  }

  return { party }
}

// ── Action types ──────────────────────────────────────────

type WpAction =
  | 'create'
  | 'invite'
  | 'accept'
  | 'reject'
  | 'leave'
  | 'end'
  | 'pick-content'
  | 'start'
  | 'pause'
  | 'play'
  | 'seek'
  | 'sync'
  | 'remove-member'

interface WpRequest {
  action: WpAction
  [key: string]: unknown
}

// ── POST handler ──────────────────────────────────────────

export async function POST(request: Request) {
  const ip = getClientIp(request)
  const rl = rateLimit(ip, RATE_LIMITS.user)
  if (!rl.allowed) return rateLimitResponse(rl, RATE_LIMITS.user)

  if (!supabaseAvailable || !admin) {
    return NextResponse.json({ error: 'Database unavailable' }, { status: 503 })
  }

  let body: WpRequest & { token?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const auth = await verifyAuth(request, body)
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { action } = body
  if (!action) {
    return NextResponse.json({ error: 'Missing action field' }, { status: 400 })
  }

  try {
    switch (action) {
      case 'create':
        return await handleCreate(auth.userId, body)
      case 'invite':
        return await handleInvite(auth.userId, body)
      case 'accept':
        return await handleAccept(auth.userId, body)
      case 'reject':
        return await handleReject(auth.userId, body)
      case 'leave':
        return await handleLeave(auth.userId, body)
      case 'end':
        return await handleEnd(auth.userId, body)
      case 'pick-content':
        return await handlePickContent(auth.userId, body)
      case 'start':
        return await handleStart(auth.userId, body)
      case 'pause':
        return await handlePause(auth.userId, body)
      case 'play':
        return await handlePlay(auth.userId, body)
      case 'seek':
        return await handleSeek(auth.userId, body)
      case 'sync':
        return await handleSync(auth.userId, body)
      case 'remove-member':
        return await handleRemoveMember(auth.userId, body)
      default:
        return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 })
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal server error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

// ── Action: create ────────────────────────────────────────

async function handleCreate(userId: string, body: WpRequest) {
  // Clean up any stale "waiting" parties the host created previously
  await admin!
    .from('watch_parties')
    .update({ status: 'ended', ended_at: new Date().toISOString() })
    .eq('host_id', userId)
    .eq('status', 'waiting')

  // Also mark the host's old memberships as 'left'
  const { data: oldParties } = await admin!
    .from('watch_parties')
    .select('id')
    .eq('host_id', userId)
    .eq('status', 'ended')

  if (oldParties && oldParties.length > 0) {
    const oldPartyIds = oldParties.map((p) => p.id)
    await admin!
      .from('watch_party_members')
      .update({ status: 'left' })
      .in('party_id', oldPartyIds)
      .eq('user_id', userId)
      .in('status', ['joined', 'invited'])
  }

  // Insert the new party
  const { data: party, error: insertError } = await admin!
    .from('watch_parties')
    .insert({
      host_id: userId,
      status: 'waiting',
      playback_time: 0,
      is_playing: false,
    })
    .select()
    .single()

  if (insertError || !party) {
    return NextResponse.json({ error: insertError?.message || 'Failed to create party' }, { status: 500 })
  }

  // Insert host as joined member
  const { error: memberInsertError } = await admin!
    .from('watch_party_members')
    .insert({
      party_id: party.id,
      user_id: userId,
      status: 'joined',
    })

  if (memberInsertError) {
    // Roll back the party creation — host must be a member
    await admin!.from('watch_parties').delete().eq('id', party.id)
    return NextResponse.json({ error: memberInsertError.message || 'Failed to add host as member' }, { status: 500 })
  }

  // Fetch host profile for the response
  const { data: hostProfile } = await admin!
    .from('profiles')
    .select('id, display_name, avatar_url')
    .eq('id', userId)
    .maybeSingle()

  return NextResponse.json({
    party: {
      id: party.id,
      hostId: party.host_id,
      contentId: party.content_id,
      mediaType: party.media_type,
      season: party.season,
      episode: party.episode,
      contentTitle: party.content_title,
      contentPoster: party.content_poster,
      status: party.status,
      playbackTime: party.playback_time,
      isPlaying: party.is_playing,
      pausedBy: party.paused_by,
      createdAt: new Date(party.created_at).getTime(),
      members: [{
        userId,
        displayName: hostProfile?.display_name || 'Unknown',
        avatarUrl: hostProfile?.avatar_url || null,
        isHost: true,
        isTalking: false,
        memberStatus: 'joined',
      }],
    },
  })
}

// ── Action: invite ────────────────────────────────────────

async function handleInvite(userId: string, body: WpRequest) {
  const partyId = validateUuid(body.partyId, 'partyId')
  const targetUserId = validateUuid(body.targetUserId, 'targetUserId')

  if (!partyId || !targetUserId) {
    return NextResponse.json({ error: 'Missing or invalid partyId or targetUserId' }, { status: 400 })
  }

  // Step 1: Verify the caller is the host of this party
  const { data: party, error: partyError } = await admin!
    .from('watch_parties')
    .select('id, host_id')
    .eq('id', partyId)
    .maybeSingle()

  if (partyError || !party) {
    return NextResponse.json({ error: 'Party not found' }, { status: 404 })
  }

  if (party.host_id !== userId) {
    return NextResponse.json({ error: 'Only the host can send invitations' }, { status: 403 })
  }

  // Step 2: Enforce party size limit
  const { count } = await admin!
    .from('watch_party_members')
    .select('*', { count: 'exact', head: true })
    .eq('party_id', partyId)
    .in('status', ['joined', 'invited'])

  if ((count ?? 0) >= MAX_PARTY_MEMBERS) {
    return NextResponse.json({ error: `Party is full (max ${MAX_PARTY_MEMBERS} members)` }, { status: 409 })
  }

  // Step 3: Check if target user is already in ANY active party
  const { data: targetMemberships } = await admin!
    .from('watch_party_members')
    .select('party_id, status')
    .eq('user_id', targetUserId)
    .in('status', ['joined', 'invited'])

  if (targetMemberships && targetMemberships.length > 0) {
    const activePartyIds = targetMemberships.map((m) => m.party_id)
    const { data: activeParties } = await admin!
      .from('watch_parties')
      .select('id')
      .in('id', activePartyIds)
      .neq('status', 'ended')

    if (activeParties && activeParties.length > 0) {
      return NextResponse.json({ error: 'This user is already in a watch party' }, { status: 409 })
    }
  }

  // Step 4: Check if already invited/joined to THIS party
  const { data: existing } = await admin!
    .from('watch_party_members')
    .select('id, status')
    .eq('party_id', partyId)
    .eq('user_id', targetUserId)
    .in('status', ['joined', 'invited'])
    .maybeSingle()

  if (existing) {
    if (existing.status === 'invited') {
      return NextResponse.json({ error: 'User already has a pending invitation' }, { status: 409 })
    } else {
      return NextResponse.json({ error: 'User is already in the party' }, { status: 409 })
    }
  }

  // Step 5: Upsert invite record
  const { error: upsertError } = await admin!
    .from('watch_party_members')
    .upsert(
      {
        party_id: partyId,
        user_id: targetUserId,
        status: 'invited',
        joined_at: null,
      },
      { onConflict: 'party_id, user_id' },
    )

  if (upsertError) {
    return NextResponse.json({ error: upsertError.message || 'Failed to save invitation' }, { status: 500 })
  }

  // Step 6: Fetch target user's profile for the response
  const { data: targetProfile } = await admin!
    .from('profiles')
    .select('id, display_name, avatar_url')
    .eq('id', targetUserId)
    .maybeSingle()

  // Step 7: Fetch host profile for broadcast
  const { data: hostProfile } = await admin!
    .from('profiles')
    .select('id, display_name, avatar_url')
    .eq('id', userId)
    .maybeSingle()

  return NextResponse.json({
    success: true,
    invitedMember: {
      userId: targetUserId,
      displayName: targetProfile?.display_name || 'Unknown',
      avatarUrl: targetProfile?.avatar_url || null,
      isHost: false,
      isTalking: false,
      memberStatus: 'invited',
    },
    hostProfile: {
      hostName: hostProfile?.display_name || 'Unknown',
      hostAvatarUrl: hostProfile?.avatar_url || null,
    },
  })
}

// ── Action: accept ────────────────────────────────────────

async function handleAccept(userId: string, body: WpRequest) {
  const partyId = validateUuid(body.partyId, 'partyId')
  if (!partyId) {
    return NextResponse.json({ error: 'Missing or invalid partyId' }, { status: 400 })
  }

  // Update member status to joined (only if currently 'invited')
  const { data: updatedRows, error: updateError } = await admin!
    .from('watch_party_members')
    .update({ status: 'joined', joined_at: new Date().toISOString() })
    .eq('party_id', partyId)
    .eq('user_id', userId)
    .eq('status', 'invited')
    .select()

  if (updateError) {
    return NextResponse.json({ error: updateError.message || 'Failed to join party' }, { status: 500 })
  }

  // Verify the user was actually invited (update affected 0 rows)
  if (!updatedRows || updatedRows.length === 0) {
    return NextResponse.json({ error: 'No pending invitation found for this party' }, { status: 403 })
  }

  // Fetch full party data with members
  const party = await fetchPartyWithMembers(partyId)
  if (!party) {
    return NextResponse.json({ error: 'Party not found' }, { status: 404 })
  }

  if (party.status === 'ended') {
    return NextResponse.json({ error: 'This watch party has already ended' }, { status: 410 })
  }

  return NextResponse.json({ party })
}

// ── Action: reject ────────────────────────────────────────

async function handleReject(userId: string, body: WpRequest) {
  const partyId = validateUuid(body.partyId, 'partyId')
  if (!partyId) {
    return NextResponse.json({ error: 'Missing or invalid partyId' }, { status: 400 })
  }

  const { error } = await admin!
    .from('watch_party_members')
    .update({ status: 'rejected' })
    .eq('party_id', partyId)
    .eq('user_id', userId)

  if (error) {
    return NextResponse.json({ error: error.message || 'Failed to reject invitation' }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}

// ── Action: leave ─────────────────────────────────────────

async function handleLeave(userId: string, body: WpRequest) {
  const partyId = validateUuid(body.partyId, 'partyId')
  if (!partyId) {
    return NextResponse.json({ error: 'Missing or invalid partyId' }, { status: 400 })
  }

  const { error } = await admin!
    .from('watch_party_members')
    .update({ status: 'left' })
    .eq('party_id', partyId)
    .eq('user_id', userId)

  if (error) {
    return NextResponse.json({ error: error.message || 'Failed to leave party' }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}

// ── Action: end ───────────────────────────────────────────

async function handleEnd(userId: string, body: WpRequest) {
  const partyId = validateUuid(body.partyId, 'partyId')
  if (!partyId) {
    return NextResponse.json({ error: 'Missing or invalid partyId' }, { status: 400 })
  }

  // Verify caller is the host
  const hostResult = await verifyHost(userId, partyId)
  if (hostResult instanceof NextResponse) return hostResult

  // End the party
  const { error: endError } = await admin!
    .from('watch_parties')
    .update({ status: 'ended', ended_at: new Date().toISOString() })
    .eq('id', partyId)

  if (endError) {
    return NextResponse.json({ error: endError.message || 'Failed to end party' }, { status: 500 })
  }

  // Mark all active members as 'left'
  await admin!
    .from('watch_party_members')
    .update({ status: 'left' })
    .eq('party_id', partyId)
    .in('status', ['joined', 'invited'])

  return NextResponse.json({ success: true })
}

// ── Action: pick-content ──────────────────────────────────

async function handlePickContent(userId: string, body: WpRequest) {
  const partyId = validateUuid(body.partyId, 'partyId')
  if (!partyId) {
    return NextResponse.json({ error: 'Missing or invalid partyId' }, { status: 400 })
  }

  // Verify caller is the host
  const hostResult = await verifyHost(userId, partyId)
  if (hostResult instanceof NextResponse) return hostResult

  const contentId = validateString(body.contentId)
  const mediaType = validateMediaType(body.mediaType)
  const season = validateNullableNumber(body.season)
  const episode = validateNullableNumber(body.episode)
  const contentTitle = validateString(body.contentTitle, MAX_CONTENT_TITLE_LENGTH)
  const contentPoster = validateString(body.contentPoster as string | null | undefined)

  if (!contentId || !mediaType) {
    return NextResponse.json({ error: 'Missing or invalid contentId or mediaType' }, { status: 400 })
  }

  const { error } = await admin!
    .from('watch_parties')
    .update({
      content_id: contentId,
      media_type: mediaType,
      season,
      episode,
      content_title: contentTitle ?? null,
      content_poster: contentPoster ?? null,
    })
    .eq('id', partyId)

  if (error) {
    return NextResponse.json({ error: error.message || 'Failed to set content' }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}

// ── Action: start ─────────────────────────────────────────

async function handleStart(userId: string, body: WpRequest) {
  const partyId = validateUuid(body.partyId, 'partyId')
  const currentTime = validateFiniteNumber(body.currentTime)

  if (!partyId) {
    return NextResponse.json({ error: 'Missing or invalid partyId' }, { status: 400 })
  }

  // Verify caller is the host
  const hostResult = await verifyHost(userId, partyId)
  if (hostResult instanceof NextResponse) return hostResult

  const { error } = await admin!
    .from('watch_parties')
    .update({
      status: 'playing',
      is_playing: true,
      playback_time: currentTime ?? 0,
    })
    .eq('id', partyId)

  if (error) {
    return NextResponse.json({ error: error.message || 'Failed to start party' }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}

// ── Action: pause ─────────────────────────────────────────

async function handlePause(userId: string, body: WpRequest) {
  const partyId = validateUuid(body.partyId, 'partyId')
  const currentTime = validateFiniteNumber(body.currentTime)

  if (!partyId) {
    return NextResponse.json({ error: 'Missing or invalid partyId' }, { status: 400 })
  }

  // Verify caller is a joined member of this party
  const memberResult = await verifyMembership(userId, partyId)
  if (memberResult instanceof NextResponse) return memberResult

  const { error } = await admin!
    .from('watch_parties')
    .update({
      is_playing: false,
      playback_time: currentTime ?? (memberResult.party as Record<string, unknown>).playback_time ?? 0,
      paused_by: userId,
    })
    .eq('id', partyId)

  if (error) {
    return NextResponse.json({ error: error.message || 'Failed to pause' }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}

// ── Action: play ──────────────────────────────────────────

async function handlePlay(userId: string, body: WpRequest) {
  const partyId = validateUuid(body.partyId, 'partyId')
  const currentTime = validateFiniteNumber(body.currentTime)

  if (!partyId) {
    return NextResponse.json({ error: 'Missing or invalid partyId' }, { status: 400 })
  }

  // Verify caller is a joined member of this party
  const memberResult = await verifyMembership(userId, partyId)
  if (memberResult instanceof NextResponse) return memberResult

  const { error } = await admin!
    .from('watch_parties')
    .update({
      is_playing: true,
      playback_time: currentTime ?? (memberResult.party as Record<string, unknown>).playback_time ?? 0,
      paused_by: null,
    })
    .eq('id', partyId)

  if (error) {
    return NextResponse.json({ error: error.message || 'Failed to resume' }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}

// ── Action: seek ──────────────────────────────────────────

async function handleSeek(userId: string, body: WpRequest) {
  const partyId = validateUuid(body.partyId, 'partyId')
  const currentTime = validateFiniteNumber(body.currentTime)

  if (!partyId) {
    return NextResponse.json({ error: 'Missing or invalid partyId' }, { status: 400 })
  }

  if (currentTime === undefined) {
    return NextResponse.json({ error: 'Missing or invalid currentTime' }, { status: 400 })
  }

  // Verify caller is a joined member of this party
  const memberResult = await verifyMembership(userId, partyId)
  if (memberResult instanceof NextResponse) return memberResult

  const { error } = await admin!
    .from('watch_parties')
    .update({ playback_time: currentTime })
    .eq('id', partyId)

  if (error) {
    return NextResponse.json({ error: error.message || 'Failed to seek' }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}

// ── Action: sync ──────────────────────────────────────────

async function handleSync(userId: string, body: WpRequest) {
  const partyId = validateUuid(body.partyId, 'partyId')
  const currentTime = validateFiniteNumber(body.currentTime)
  const isPlaying = typeof body.isPlaying === 'boolean' ? body.isPlaying : undefined

  if (!partyId) {
    return NextResponse.json({ error: 'Missing or invalid partyId' }, { status: 400 })
  }

  // Verify caller is a joined member (specifically the host for sync)
  const hostResult = await verifyHost(userId, partyId)
  if (hostResult instanceof NextResponse) return hostResult

  const { error } = await admin!
    .from('watch_parties')
    .update({
      playback_time: currentTime ?? 0,
      is_playing: isPlaying ?? false,
    })
    .eq('id', partyId)

  if (error) {
    return NextResponse.json({ error: error.message || 'Failed to sync' }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}

// ── Action: remove-member ─────────────────────────────

async function handleRemoveMember(userId: string, body: WpRequest) {
  const partyId = validateUuid(body.partyId, 'partyId')
  const targetUserId = validateUuid(body.targetUserId, 'targetUserId')

  if (!partyId || !targetUserId) {
    return NextResponse.json({ error: 'Missing or invalid partyId or targetUserId' }, { status: 400 })
  }

  if (targetUserId === userId) {
    return NextResponse.json({ error: 'Cannot remove yourself — use leave instead' }, { status: 400 })
  }

  // Verify caller is the host
  const hostResult = await verifyHost(userId, partyId)
  if (hostResult instanceof NextResponse) return hostResult

  const { error } = await admin!
    .from('watch_party_members')
    .update({ status: 'left' })
    .eq('party_id', partyId)
    .eq('user_id', targetUserId)

  if (error) {
    return NextResponse.json({ error: error.message || 'Failed to remove member' }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}

// ── Shared helper: fetch party with members ───────────────

async function fetchPartyWithMembers(partyId: string) {
  const { data: party, error } = await admin!
    .from('watch_parties')
    .select('*')
    .eq('id', partyId)
    .maybeSingle()

  if (error || !party) return null

  const { data: memberRows } = await admin!
    .from('watch_party_members')
    .select('user_id, status')
    .eq('party_id', partyId)
    .in('status', ['joined', 'invited'])

  const memberUserIds = (memberRows || []).map((m) => m.user_id)
  const memberStatusMap = new Map((memberRows || []).map((m) => [m.user_id, m.status]))

  const { data: profiles } = await admin!
    .from('profiles')
    .select('id, display_name, avatar_url')
    .in('id', memberUserIds.length > 0 ? memberUserIds : ['__none__'])

  const profileMap = new Map((profiles || []).map((p) => [p.id, p]))

  const members = memberUserIds.map((uid) => {
    const profile = profileMap.get(uid)
    return {
      userId: uid,
      displayName: profile?.display_name || 'Unknown',
      avatarUrl: profile?.avatar_url || null,
      isHost: uid === party.host_id,
      isTalking: false,
      memberStatus: memberStatusMap.get(uid) || 'joined',
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
    playbackTime: party.playback_time || 0,
    isPlaying: party.is_playing,
    pausedBy: party.paused_by,
    createdAt: new Date(party.created_at).getTime(),
    members,
  }
}
