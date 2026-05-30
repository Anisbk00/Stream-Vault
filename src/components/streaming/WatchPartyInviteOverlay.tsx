/**
 * StreamVault — Watch Party Invitation Overlay
 *
 * Global overlay that appears when a user receives a watch party invitation.
 * Shows anywhere in the app, with accept/reject actions.
 * Auto-dismisses after 30 seconds if no action is taken.
 */

'use client'

import { useState, useEffect, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Users, Check, PhoneOff, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { useWatchPartyStore } from '@/store/watch-party'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import type { WatchPartyInvitation } from '@/lib/watch-party-types'

const AUTO_DISMISS_MS = 30_000

interface InvitationCardProps {
  invitation: WatchPartyInvitation
  onAccept: (invitation: WatchPartyInvitation) => void
  onReject: (invitation: WatchPartyInvitation) => void
  onDismiss: (partyId: string) => void
}

function InvitationCard({ invitation, onAccept, onReject, onDismiss }: InvitationCardProps) {
  const [isJoining, setIsJoining] = useState(false)
  const [isRejecting, setIsRejecting] = useState(false)

  // Auto-dismiss after 30s (paused while joining/rejecting)
  useEffect(() => {
    if (isJoining || isRejecting) return
    const timer = setTimeout(() => onDismiss(invitation.partyId), AUTO_DISMISS_MS)
    return () => clearTimeout(timer)
  }, [invitation.partyId, onDismiss, isJoining, isRejecting])

  const initials = invitation.hostName
    .split(' ')
    .filter(Boolean)
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase()

  return (
    <motion.div
      initial={{ opacity: 0, y: -20, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -20, scale: 0.95 }}
      transition={{ type: 'spring', damping: 25, stiffness: 300 }}
      className="bg-[#1a1a1a] border border-white/[0.1] rounded-2xl p-4 shadow-2xl shadow-black/40 min-w-[300px] max-w-[380px]"
    >
      {/* Dismiss button */}
      <button
        onClick={() => onDismiss(invitation.partyId)}
        className="absolute -top-2 -right-2 w-6 h-6 flex items-center justify-center rounded-full bg-white/10 hover:bg-white/20 transition-colors cursor-pointer"
        aria-label="Dismiss"
      >
        <X className="size-3 text-[#A0A0A0]" />
      </button>

      {/* Header */}
      <div className="flex items-center gap-3 mb-3">
        <div className="relative">
          <Avatar className="w-11 h-11 border border-white/10">
            <AvatarImage src={invitation.hostAvatarUrl || undefined} alt={invitation.hostName} />
            <AvatarFallback className="text-sm font-bold bg-[#0a0a0a] text-sv-red">{initials || '?'}</AvatarFallback>
          </Avatar>
          <div className="absolute -bottom-0.5 -right-0.5 w-4 h-4 rounded-full bg-sv-red border-2 border-[#1a1a1a] flex items-center justify-center">
            <Users className="size-2 text-white" />
          </div>
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-[#F5F5F5] truncate">{invitation.hostName}</p>
          <p className="text-xs text-[#808080]">invites you to a Watch Party</p>
        </div>
      </div>

      {/* Member count */}
      <div className="flex items-center gap-1.5 mb-3 px-1">
        <Users className="size-3.5 text-[#606060]" />
        <span className="text-xs text-[#606060]">{invitation.memberCount} {invitation.memberCount === 1 ? 'person' : 'people'} waiting</span>
      </div>

      {/* Actions */}
      <div className="flex gap-2">
        <button
          onClick={async () => {
            setIsRejecting(true)
            try {
              await onReject(invitation)
            } catch {
              toast.error('Failed to decline invitation')
            }
          }}
          disabled={isJoining || isRejecting}
          className="flex-1 flex items-center justify-center gap-1.5 bg-white/[0.06] hover:bg-white/[0.1] border border-white/[0.08] text-[#A0A0A0] hover:text-[#F5F5F5] font-medium py-2.5 rounded-xl transition-all cursor-pointer press-effect text-sm disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isRejecting ? <Loader2 className="size-3.5 animate-spin" /> : <PhoneOff className="size-3.5" />}
          {isRejecting ? 'Declining...' : 'Decline'}
        </button>
        <button
          onClick={async () => {
            setIsJoining(true)
            toast.loading('Joining watch party...', { id: 'wp-join-flow', duration: 15_000 })
            try {
              await onAccept(invitation)
              // acceptInvite handles its own success/error toasts.
              // Dismiss our loading toast — the hook's toast will replace it.
              // Small delay to avoid flash if the hook's toast fires immediately.
              setTimeout(() => toast.dismiss('wp-join-flow'), 200)
            } catch {
              toast.error('Failed to join — please try again', { id: 'wp-join-flow' })
            }
          }}
          disabled={isJoining || isRejecting}
          className="flex-1 flex items-center justify-center gap-1.5 bg-sv-red hover:bg-sv-red-hover text-white font-semibold py-2.5 rounded-xl transition-all cursor-pointer press-effect text-sm disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isJoining ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
          {isJoining ? 'Joining...' : 'Join'}
        </button>
      </div>
    </motion.div>
  )
}

// ── Main overlay component ─────────────────────────────────

interface WatchPartyInviteOverlayProps {
  onAccept: (invitation: WatchPartyInvitation) => void
  onReject: (invitation: WatchPartyInvitation) => void
}

export default function WatchPartyInviteOverlay({ onAccept, onReject }: WatchPartyInviteOverlayProps) {
  const pendingInvitations = useWatchPartyStore((s) => s.pendingInvitations)
  const removeInvitation = useWatchPartyStore((s) => s.removeInvitation)

  const handleDismiss = useCallback((partyId: string) => {
    removeInvitation(partyId)
  }, [removeInvitation])

  if (pendingInvitations.length === 0) return null

  return (
    <div className="fixed top-4 right-4 z-[100] flex flex-col gap-3 pointer-events-none">
      <AnimatePresence>
        {pendingInvitations.map((invitation) => (
          <div key={invitation.partyId} className="relative pointer-events-auto">
            <InvitationCard
              invitation={invitation}
              onAccept={onAccept}
              onReject={onReject}
              onDismiss={handleDismiss}
            />
          </div>
        ))}
      </AnimatePresence>
    </div>
  )
}
