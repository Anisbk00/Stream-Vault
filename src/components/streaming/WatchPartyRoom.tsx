/**
 * StreamVault — Watch Party Room UI
 *
 * Pill-shaped floating tab on the right edge that doesn't hide content.
 * Click to expand the full panel with members, PTT, and controls.
 * Collapses back to the pill tab when minimized.
 */

'use client'

import { useState, useCallback, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { getPlayerContainerForPtt } from '@/components/streaming/VideoPlayer'
import { isIOSDevice } from '@/lib/voice-clip'
import {
  ChevronRight,
  Crown,
  LogOut,
  Mic,
  MicOff,
  MonitorPlay,
  Play,
  RefreshCw,
  X,
  Users,
  PhoneOff,
  Clock,
  MessageCircle,
  ChevronLeft,
} from 'lucide-react'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { useWatchPartyStore } from '@/store/watch-party'
import { useAuthStore } from '@/store'
import { toast } from 'sonner'

// ── Props ──────────────────────────────────────────────────

interface WatchPartyRoomProps {
  onPickContent: () => void
  onStartParty: () => void
  onLeave: () => void
  onEnd: () => void
  onPttStart: () => void
  onPttStop: () => void
}

// ── Component ──────────────────────────────────────────────

export default function WatchPartyRoom({
  onPickContent,
  onStartParty,
  onLeave,
  onEnd,
  onPttStart,
  onPttStop,
}: WatchPartyRoomProps) {
  const currentParty = useWatchPartyStore((s) => s.currentParty)
  const isInParty = useWatchPartyStore((s) => s.isInParty)
  const isHost = useWatchPartyStore((s) => s.isHost)
  const isPttActive = useWatchPartyStore((s) => s.isPttActive)
  const talkingMembers = useWatchPartyStore((s) => s.talkingMembers)
  const isRoomVisible = useWatchPartyStore((s) => s.isRoomVisible)
  const setRoomVisible = useWatchPartyStore((s) => s.setRoomVisible)
  const pauseNotification = useWatchPartyStore((s) => s.pauseNotification)

  const voiceStatus = useWatchPartyStore((s) => s.voiceStatus)
  const voiceError = useWatchPartyStore((s) => s.voiceError)

  const userId = useAuthStore((s) => s.user?.id)
  const [isPttPressed, setIsPttPressed] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const floatingPttRef = useRef<HTMLButtonElement>(null)

  // Track fullscreen state for floating PTT button visibility
  useEffect(() => {
    const handleChange = () => {
      setIsFullscreen(!!(document.fullscreenElement || (document as unknown as Record<string, unknown>).webkitFullscreenElement))
    }
    document.addEventListener('fullscreenchange', handleChange)
    document.addEventListener('webkitfullscreenchange', handleChange)
    return () => {
      document.removeEventListener('fullscreenchange', handleChange)
      document.removeEventListener('webkitfullscreenchange', handleChange)
    }
  }, [])

  const handlePttDown = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsPttPressed(true)
    onPttStart()
  }, [onPttStart])

  const handlePttUp = useCallback(() => {
    setIsPttPressed(false)
    onPttStop()
  }, [onPttStop])

  // Safety net: if the user holds PTT and the mouse/touch leaves the button
  // or the window loses focus, stop PTT automatically
  useEffect(() => {
    if (!isPttPressed) return

    const handleGlobalUp = () => {
      setIsPttPressed(false)
      onPttStop()
    }

    window.addEventListener('mouseup', handleGlobalUp)
    window.addEventListener('touchend', handleGlobalUp)
    window.addEventListener('touchcancel', handleGlobalUp)

    return () => {
      window.removeEventListener('mouseup', handleGlobalUp)
      window.removeEventListener('touchend', handleGlobalUp)
      window.removeEventListener('touchcancel', handleGlobalUp)
    }
  }, [isPttPressed, onPttStop])

  if (!isInParty || !currentParty) return null

  const members = currentParty.members
  const isPlaying = currentParty.playbackState.isPlaying
  const pausedBy = currentParty.playbackState.pausedBy

  // ── Floating PTT button (visible when panel is collapsed OR in fullscreen) ──
  // CRITICAL: In fullscreen mode, the Fullscreen API only renders descendants
  // of the fullscreen element. Portaling to document.body hides the button.
  // Solution: portal into the video player container when fullscreen (it IS
  // the fullscreen element), fall back to document.body otherwise.
  const showFloatingPtt = !isRoomVisible || isFullscreen
  const pttPortalTarget = isFullscreen
    ? getPlayerContainerForPtt() || document.body
    : document.body
  const floatingPtt = showFloatingPtt && typeof document !== 'undefined' ? createPortal(
    <motion.button
      ref={floatingPttRef}
      initial={{ opacity: 0, scale: 0.8, y: 20 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.8, y: 20 }}
      transition={{ duration: 0.15 }}
      onMouseDown={handlePttDown}
      onMouseUp={handlePttUp}
      onMouseLeave={() => { if (isPttPressed) handlePttUp() }}
      onTouchStart={handlePttDown}
      onTouchEnd={handlePttUp}
      onTouchCancel={() => { if (isPttPressed) handlePttUp() }}
      className={`fixed bottom-24 right-6 z-[999999] w-14 h-14 rounded-full flex items-center justify-center shadow-2xl transition-all cursor-pointer select-none ${
        isPttPressed
          ? 'bg-sv-red text-white shadow-lg shadow-sv-red/40 scale-110'
          : 'bg-[#1a1a1a]/90 backdrop-blur-md border border-white/[0.15] text-[#A0A0A0] hover:text-white hover:border-sv-red/50'
      }`}
      style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)', paddingRight: 'env(safe-area-inset-right, 0px)' }}
      aria-label={isPttPressed ? 'Release to stop talking' : 'Push to talk'}
    >
      {isPttPressed ? <Mic className="size-5" /> : <MicOff className="size-5" />}
      {isPttPressed && (
        <div className="absolute inset-0 rounded-full bg-sv-red/30 animate-ping" />
      )}
    </motion.button>,
    pttPortalTarget
  ) : null

  // ── Collapsed pill tab (visible when panel is minimized) ──
  if (!isRoomVisible) {
    const anyoneTalking = isPttActive || talkingMembers.size > 0

    return (
      <>
        {floatingPtt}
        <motion.button
        initial={{ opacity: 0, x: 20 }}
        animate={{ opacity: 1, x: 0 }}
        exit={{ opacity: 0, x: 20 }}
        transition={{ duration: 0.2 }}
        onClick={() => setRoomVisible(true)}
        className="fixed right-0 top-1/2 -translate-y-1/2 z-[200] group cursor-pointer"
        aria-label="Reopen watch party panel"
      >
        {/* Glow ring when someone is talking */}
        {anyoneTalking && (
          <div className="absolute inset-[-3px] rounded-l-2xl bg-sv-red/30 animate-ping" />
        )}
        <div className={`relative flex items-center gap-1.5 pl-3 pr-2 py-3 rounded-l-2xl shadow-xl shadow-black/50 transition-all press-effect ${
          anyoneTalking
            ? 'bg-sv-red'
            : 'bg-[#1a1a1a] border border-r-0 border-white/[0.15] hover:border-sv-red/50'
        }`}>
          <MessageCircle className={`size-4 flex-shrink-0 ${anyoneTalking ? 'text-white' : 'text-[#A0A0A0] group-hover:text-sv-red'}`} />
          <span className={`text-[11px] font-semibold whitespace-nowrap ${anyoneTalking ? 'text-white' : 'text-[#A0A0A0] group-hover:text-sv-red'}`}>
            Party
          </span>
          {/* Member count badge */}
          <div className="min-w-[18px] h-[18px] rounded-full bg-sv-red text-white text-[9px] font-bold flex items-center justify-center px-1 shadow-lg flex-shrink-0">
            {members.length}
          </div>
          {/* Chevron left to indicate "click to expand" */}
          <ChevronLeft className="size-3 text-[#606060] group-hover:text-sv-red flex-shrink-0 transition-colors" />
          {/* Online indicator dot */}
          <div className="absolute -top-1 left-3 w-2.5 h-2.5 rounded-full bg-green-500 border-2 border-[#1a1a1a]" />
        </div>
      </motion.button>
      </>
    )
  }

  // ── Expanded panel mode ────────────────────────────────────
  return (
    <>
      {floatingPtt}
      <AnimatePresence>
        <motion.div
        initial={{ opacity: 0, x: 20 }}
        animate={{ opacity: 1, x: 0 }}
        exit={{ opacity: 0, x: 20 }}
        transition={{ duration: 0.2 }}
        className="fixed right-3 top-1/2 -translate-y-1/2 z-[200] w-[260px]"
      >
        {/* ── Header bar ──────────────────────────────── */}
        <div className="bg-[#1a1a1a] border border-white/[0.08] rounded-t-2xl px-3 py-2.5 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
            <span className="text-[13px] font-semibold text-[#F5F5F5]">Watch Party</span>
            <span className="text-[10px] text-[#606060] bg-white/[0.06] px-1.5 py-0.5 rounded-full">
              {members.length}
            </span>
          </div>
          <button
            onClick={() => setRoomVisible(false)}
            className="w-6 h-6 flex items-center justify-center rounded-lg hover:bg-white/[0.06] transition-colors cursor-pointer"
            aria-label="Minimize panel"
          >
            <ChevronRight className="size-4 text-[#A0A0A0]" />
          </button>
        </div>

        {/* ── Content ──────────────────────────────────── */}
        <div className="bg-[#141414] border-x border-b border-white/[0.08] rounded-b-2xl">
          {/* ── Content info ────────────────────── */}
          {currentParty.contentTitle ? (
            <div className="px-3 py-2.5 border-b border-white/[0.06]">
              <div className="flex items-center gap-2">
                <MonitorPlay className="size-3.5 text-sv-red flex-shrink-0" />
                <p className="text-[12px] font-medium text-[#F5F5F5] truncate">
                  {currentParty.contentTitle}
                </p>
              </div>
              {currentParty.mediaType === 'tv' && currentParty.season != null && currentParty.episode != null && (
                <p className="text-[10px] text-[#808080] mt-0.5 ml-5.5">
                  S{currentParty.season} · E{currentParty.episode}
                </p>
              )}
              {currentParty.status === 'waiting' && !isPlaying && (
                <p className="text-[10px] text-[#606060] mt-0.5 ml-5.5">Waiting to start...</p>
              )}
              {currentParty.status === 'playing' && isPlaying && (
                <p className="text-[10px] text-green-500 mt-0.5 ml-5.5">Now playing</p>
              )}
              {pausedBy && (
                <p className="text-[10px] text-yellow-500 mt-0.5 ml-5.5">
                  Paused by {members.find(m => m.userId === pausedBy)?.displayName ?? 'someone'}
                </p>
              )}
            </div>
          ) : isHost ? (
            <div className="px-3 py-2.5 border-b border-white/[0.06]">
              <button
                onClick={onPickContent}
                className="w-full flex items-center justify-center gap-1.5 bg-sv-red/15 hover:bg-sv-red/25 border border-sv-red/30 text-sv-red font-medium py-2 rounded-xl transition-all cursor-pointer press-effect text-[12px]"
              >
                <MonitorPlay className="size-3.5" />
                Pick a Movie or Series
              </button>
            </div>
          ) : (
            <div className="px-3 py-2.5 border-b border-white/[0.06]">
              <p className="text-[10px] text-[#606060] text-center">Waiting for host to pick content...</p>
            </div>
          )}

          {/* ── Host: Start/Resume button ──────────────── */}
          {isHost && currentParty.contentTitle && (currentParty.status === 'waiting' || (currentParty.status === 'playing' && !isPlaying)) && (
            <div className="px-3 py-2 border-b border-white/[0.06]">
              <button
                onClick={onStartParty}
                className="w-full flex items-center justify-center gap-1.5 bg-green-600/20 hover:bg-green-600/30 border border-green-600/30 text-green-400 font-medium py-2 rounded-xl transition-all cursor-pointer press-effect text-[12px]"
              >
                <Play className="size-3.5" />
                Start Watch Party
              </button>
            </div>
          )}

          {/* ── Host: Change content button ── */}
          {isHost && currentParty.contentTitle && (currentParty.status === 'waiting' || currentParty.status === 'playing') && (
            <div className="px-3 py-2 border-b border-white/[0.06]">
              <button
                onClick={onPickContent}
                className="w-full flex items-center justify-center gap-1.5 bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] text-[#A0A0A0] hover:text-[#F5F5F5] font-medium py-1.5 rounded-xl transition-all cursor-pointer press-effect text-[11px]"
              >
                <RefreshCw className="size-3" />
                Change Content
              </button>
            </div>
          )}

          {/* ── Members list ─────────────────────── */}
          <div className="px-2.5 py-1.5">
            <div className="flex items-center justify-between px-1 mb-1">
              <p className="text-[10px] font-semibold text-[#606060] uppercase tracking-wider">
                Members · {members.length}
              </p>
            </div>
            <div className="max-h-[160px] overflow-y-auto">
              {members.map((member) => {
                const isMe = member.userId === userId
                const isTalking = isMe ? isPttActive : talkingMembers.has(member.userId)
                const memberInitials = member.displayName
                  .split(' ')
                  .filter(Boolean)
                  .map((w) => w[0])
                  .slice(0, 2)
                  .join('')
                  .toUpperCase()
                const memberStatus = member.memberStatus || 'joined'

                return (
                  <div
                    key={member.userId}
                    className={`flex items-center gap-2 px-2 py-1.5 rounded-lg transition-colors ${
                      isTalking ? 'bg-sv-red/10' : 'hover:bg-white/[0.03]'
                    }`}
                  >
                    <div className="relative flex-shrink-0">
                      <Avatar className="w-7 h-7 border border-white/[0.08]">
                        <AvatarImage src={member.avatarUrl || undefined} alt={member.displayName} />
                        <AvatarFallback className="text-[9px] font-bold bg-[#0a0a0a] text-sv-red">
                          {memberInitials || '?'}
                        </AvatarFallback>
                      </Avatar>
                      {isTalking && (
                        <div className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-sv-red border-2 border-[#141414] animate-pulse" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1">
                        <span className="text-[11px] font-medium text-[#F5F5F5] truncate">
                          {member.displayName}
                        </span>
                        {member.isHost && <Crown className="size-2.5 text-yellow-500 flex-shrink-0" />}
                        {isMe && (
                          <span className="text-[8px] text-[#606060] bg-white/[0.06] px-1 py-0.5 rounded-full flex-shrink-0">
                            You
                          </span>
                        )}
                      </div>
                      <p className="text-[9px] text-[#505050]">
                        {isTalking
                          ? 'Speaking...'
                          : member.isHost
                            ? 'Host'
                            : memberStatus === 'invited'
                              ? 'Invited'
                              : isMe
                                ? 'Online'
                                : 'Member'
                        }
                      </p>
                    </div>
                    {memberStatus === 'invited' && !member.isHost && (
                      <span className="flex items-center gap-0.5 text-[8px] text-yellow-500/80 bg-yellow-500/10 px-1 py-0.5 rounded-full flex-shrink-0">
                        <Clock className="size-2" />
                        Pending
                      </span>
                    )}
                  </div>
                )
              })}
            </div>
          </div>

          {/* ── Push-to-Talk ─────────────────────── */}
          <div className="px-3 py-2.5 border-t border-white/[0.06]">
            <button
              onMouseDown={handlePttDown}
              onMouseUp={handlePttUp}
              onMouseLeave={() => { if (isPttPressed) handlePttUp() }}
              onTouchStart={handlePttDown}
              onTouchEnd={handlePttUp}
              onTouchCancel={() => { if (isPttPressed) handlePttUp() }}
              className={`w-full flex items-center justify-center gap-1.5 py-2.5 rounded-xl font-medium text-[12px] transition-all cursor-pointer select-none press-effect ${
                isPttPressed
                  ? 'bg-sv-red text-white shadow-lg shadow-sv-red/30'
                  : 'bg-white/[0.06] hover:bg-white/[0.1] border border-white/[0.08] text-[#A0A0A0] hover:text-[#F5F5F5]'
              }`}
            >
              {isPttPressed ? (
                <>
                  <Mic className="size-3.5" />
                  Speaking...
                </>
              ) : (
                <>
                  <MicOff className="size-3.5" />
                  Push to Talk
                </>
              )}
            </button>
            {/* Voice status indicator — shows mic/connection state */}
            {voiceStatus === 'mic-denied' && (
              <p className="text-[9px] text-red-400 text-center mt-1">Mic denied — check browser permissions</p>
            )}
            {voiceStatus === 'mic-requesting' && (
              <p className="text-[9px] text-yellow-400 text-center mt-1">Requesting microphone...</p>
            )}
            {voiceStatus === 'connecting' && (
              <p className="text-[9px] text-yellow-400 text-center mt-1">Connecting voice...</p>
            )}
            {voiceStatus === 'connected' && !isPttPressed && (
              <p className="text-[9px] text-green-400/60 text-center mt-1">Voice ready</p>
            )}
            {voiceError && (
              <p className="text-[9px] text-red-400 text-center mt-0.5">{voiceError}</p>
            )}
            {/* iOS audio ducking notice */}
            {isIOSDevice() && voiceStatus === 'connected' && !isPttPressed && (
              <p className="text-[8px] text-[#505050] text-center mt-0.5">Audio briefly dips while recording on iOS</p>
            )}
            {/* Voice peer limit warning */}
            {members.length > 8 && voiceStatus === 'connected' && (
              <p className="text-[8px] text-yellow-500/60 text-center mt-0.5">Voice limited to first 8 members</p>
            )}
          </div>

          {/* ── Actions ──────────────────────────── */}
          <div className="px-3 pb-2.5 flex flex-col gap-1.5">
            {isHost ? (
              <>
                <button
                  onClick={onEnd}
                  className="w-full flex items-center justify-center gap-1.5 text-[11px] text-[#A0A0A0] hover:text-sv-red bg-white/[0.03] hover:bg-sv-red/10 py-1.5 rounded-xl transition-colors cursor-pointer press-effect"
                >
                  <PhoneOff className="size-3" />
                  End Party
                </button>
                <button
                  onClick={onLeave}
                  className="w-full flex items-center justify-center gap-1.5 text-[11px] text-[#606060] hover:text-[#A0A0A0] bg-transparent py-1 rounded-xl transition-colors cursor-pointer"
                >
                  <LogOut className="size-3" />
                  Leave Without Ending
                </button>
              </>
            ) : (
              <button
                onClick={onLeave}
                className="w-full flex items-center justify-center gap-1.5 text-[11px] text-[#A0A0A0] hover:text-sv-red bg-white/[0.03] hover:bg-sv-red/10 py-1.5 rounded-xl transition-colors cursor-pointer press-effect"
              >
                <LogOut className="size-3" />
                Leave Party
              </button>
            )}
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
    </>
  )
}
