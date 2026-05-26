/**
 * StreamVault — Watch Party Content Picker
 *
 * Search and pick a movie or series for the watch party.
 * Shows search results from TMDB, allows host to select content.
 * For TV series, shows a season/episode picker before confirming.
 */

'use client'

import { useState, useCallback, useRef, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Search, Film, Tv, X, Loader2, ChevronDown } from 'lucide-react'
import { toast } from 'sonner'
import { searchContent, fetchContentDetail, fetchSeasonDetail } from '@/services/api'
import type { ContentItem, Season, EpisodeDetail } from '@/types/streaming'

interface WatchPartyContentPickerProps {
  open: boolean
  onClose: () => void
  onPick: (item: ContentItem & { season?: number; episode?: number }) => void
}

// ── Season/Episode Picker Sub-component ──────────────────────

function SeasonEpisodePicker({
  item,
  onConfirm,
  onCancel,
}: {
  item: ContentItem
  onConfirm: (season: number, episode: number) => void
  onCancel: () => void
}) {
  const [seasons, setSeasons] = useState<Season[]>([])
  const [selectedSeason, setSelectedSeason] = useState<number>(1)
  const [episodes, setEpisodes] = useState<EpisodeDetail[]>([])
  const [selectedEpisode, setSelectedEpisode] = useState<number>(1)
  // Derive loading states from data to avoid calling setState synchronously in effects
  const [loadedSeasons, setLoadedSeasons] = useState(false)
  const [loadedSeason, setLoadedSeason] = useState<number | null>(null)
  const isLoadingSeasons = !loadedSeasons
  const isLoadingEpisodes = loadedSeasons && selectedSeason !== loadedSeason

  // Fetch seasons from content detail
  useEffect(() => {
    let mounted = true
    fetchContentDetail(item.id, 'tv')
      .then((detail) => {
        if (!mounted) return
        const validSeasons = (detail.seasons || []).filter(
          (s) => s.season_number > 0 && s.episode_count > 0
        )
        setSeasons(validSeasons)
        if (validSeasons.length > 0) {
          setSelectedSeason(validSeasons[0].season_number)
        }
      })
      .catch(() => {
        if (mounted) toast.error('Failed to load season info')
      })
      .finally(() => {
        if (mounted) setLoadedSeasons(true)
      })
    return () => { mounted = false }
  }, [item.id])

  // Fetch episodes when season changes
  useEffect(() => {
    if (selectedSeason < 1) return
    let mounted = true
    fetchSeasonDetail(item.id, selectedSeason)
      .then((eps) => {
        if (!mounted) return
        setEpisodes(eps)
        if (eps.length > 0) {
          setSelectedEpisode(eps[0].episode_number)
        }
      })
      .catch(() => {
        if (mounted) setEpisodes([])
      })
      .finally(() => {
        if (mounted) setLoadedSeason(selectedSeason)
      })
    return () => { mounted = false }
  }, [item.id, selectedSeason])

  return (
    <div className="px-5 py-3 space-y-3">
      <p className="text-sm text-[#A0A0A0]">
        Select season and episode for <span className="text-[#F5F5F5] font-medium">{item.name || item.title}</span>
      </p>

      {isLoadingSeasons ? (
        <div className="flex items-center justify-center py-4">
          <Loader2 className="size-5 text-[#606060] animate-spin" />
        </div>
      ) : (
        <div className="flex gap-3">
          {/* Season selector */}
          <div className="flex-1">
            <label className="text-[11px] font-semibold text-[#606060] uppercase tracking-wider mb-1 block">
              Season
            </label>
            <div className="relative">
              <select
                value={selectedSeason}
                onChange={(e) => setSelectedSeason(Number(e.target.value))}
                className="w-full appearance-none bg-white/[0.06] border border-white/[0.1] rounded-xl px-3 py-2.5 pr-8 text-sm text-[#F5F5F5] outline-none focus:border-sv-red/50 transition-colors cursor-pointer"
              >
                {seasons.map((s) => (
                  <option key={s.season_number} value={s.season_number} className="bg-[#1a1a1a]">
                    Season {s.season_number}
                  </option>
                ))}
              </select>
              <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 size-4 text-[#606060] pointer-events-none" />
            </div>
          </div>

          {/* Episode selector */}
          <div className="flex-1">
            <label className="text-[11px] font-semibold text-[#606060] uppercase tracking-wider mb-1 block">
              Episode
            </label>
            <div className="relative">
              <select
                value={selectedEpisode}
                onChange={(e) => setSelectedEpisode(Number(e.target.value))}
                disabled={isLoadingEpisodes || episodes.length === 0}
                className="w-full appearance-none bg-white/[0.06] border border-white/[0.1] rounded-xl px-3 py-2.5 pr-8 text-sm text-[#F5F5F5] outline-none focus:border-sv-red/50 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isLoadingEpisodes ? (
                  <option className="bg-[#1a1a1a]">Loading...</option>
                ) : (
                  episodes.map((ep) => (
                    <option key={ep.episode_number} value={ep.episode_number} className="bg-[#1a1a1a]">
                      E{ep.episode_number} — {ep.name}
                    </option>
                  ))
                )}
              </select>
              <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 size-4 text-[#606060] pointer-events-none" />
            </div>
          </div>
        </div>
      )}

      {/* Confirm / Cancel buttons */}
      <div className="flex gap-2 pt-1">
        <button
          onClick={onCancel}
          className="flex-1 py-2.5 rounded-xl text-sm font-medium bg-white/[0.06] hover:bg-white/[0.1] text-[#A0A0A0] hover:text-[#F5F5F5] border border-white/[0.08] transition-colors cursor-pointer press-effect"
        >
          Cancel
        </button>
        <button
          onClick={() => onConfirm(selectedSeason, selectedEpisode)}
          disabled={isLoadingSeasons || episodes.length === 0}
          className="flex-1 py-2.5 rounded-xl text-sm font-medium bg-sv-red/20 hover:bg-sv-red/30 text-sv-red border border-sv-red/30 transition-colors cursor-pointer press-effect disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Confirm
        </button>
      </div>
    </div>
  )
}

// ── Main Component ───────────────────────────────────────────

export default function WatchPartyContentPicker({ open, onClose, onPick }: WatchPartyContentPickerProps) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<ContentItem[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [selectedItem, setSelectedItem] = useState<ContentItem | null>(null)
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout>>()

  // Debounced search
  useEffect(() => {
    if (!query.trim()) {
      setResults([])
      return
    }

    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current)

    searchTimeoutRef.current = setTimeout(async () => {
      setIsSearching(true)
      try {
        const items = await searchContent(query)
        setResults(items)
      } catch {
        setResults([])
      } finally {
        setIsSearching(false)
      }
    }, 400)

    return () => {
      if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current)
    }
  }, [query])

  const handlePick = useCallback((item: ContentItem) => {
    if (item.media_type === 'tv') {
      // For TV shows, show season/episode picker first
      setSelectedItem(item)
    } else {
      // For movies, pick immediately
      onPick(item)
      toast.success(`Selected: ${item.title || item.name}`)
      onClose()
    }
  }, [onPick, onClose])

  const handleSeasonEpisodeConfirm = useCallback((season: number, episode: number) => {
    if (!selectedItem) return
    const title = selectedItem.name || selectedItem.title || 'Untitled'
    onPick({
      ...selectedItem,
      season,
      episode,
      title: `${title} S${season} E${episode}`,
    })
    toast.success(`Selected: ${title} S${season} E${episode}`)
    setSelectedItem(null)
    onClose()
  }, [selectedItem, onPick, onClose])

  const handleSeasonEpisodeCancel = useCallback(() => {
    setSelectedItem(null)
  }, [])

  if (!open) return null

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[110] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.95, opacity: 0 }}
        onClick={(e) => e.stopPropagation()}
        className="bg-[#141414] border border-white/[0.08] rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/[0.06]">
          <h3 className="text-base font-bold text-[#F5F5F5]">Pick something to watch</h3>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-full bg-white/10 hover:bg-white/15 transition-colors cursor-pointer"
          >
            <X className="size-4 text-[#A0A0A0]" />
          </button>
        </div>

        {/* Season/Episode picker overlay when a TV show is selected */}
        <AnimatePresence>
          {selectedItem && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="border-b border-white/[0.06] overflow-hidden"
            >
              <SeasonEpisodePicker
                item={selectedItem}
                onConfirm={handleSeasonEpisodeConfirm}
                onCancel={handleSeasonEpisodeCancel}
              />
            </motion.div>
          )}
        </AnimatePresence>

        {/* Search */}
        <div className="px-5 py-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-[#606060]" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search movies or series..."
              className="w-full bg-white/[0.06] border border-white/[0.1] rounded-xl pl-10 pr-4 py-3 text-sm text-[#F5F5F5] placeholder:text-[#505050] outline-none focus:border-sv-red/50 transition-colors"
              autoFocus
            />
          </div>
        </div>

        {/* Results */}
        <div className="max-h-[360px] overflow-y-auto px-3 pb-3">
          {isSearching && (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="size-6 text-[#606060] animate-spin" />
            </div>
          )}

          {!isSearching && query.trim() && results.length === 0 && (
            <div className="flex flex-col items-center py-8 text-center">
              <Film className="size-8 text-[#404040] mb-2" />
              <p className="text-sm text-[#606060]">No results found</p>
            </div>
          )}

          {!isSearching && !query.trim() && (
            <div className="flex flex-col items-center py-8 text-center">
              <Search className="size-8 text-[#404040] mb-2" />
              <p className="text-sm text-[#606060]">Search for a movie or series</p>
            </div>
          )}

          {results.map((item) => {
            const isTV = item.media_type === 'tv'
            return (
              <button
                key={`${item.id}-${item.media_type}`}
                onClick={() => handlePick(item)}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-white/[0.04] transition-colors cursor-pointer text-left"
              >
                {/* Poster */}
                <div className="w-12 h-[68px] rounded-lg overflow-hidden bg-[#0a0a0a] flex-shrink-0 border border-white/[0.06]">
                  {item.poster_path ? (
                    <img
                      src={`https://image.tmdb.org/t/p/w92${item.poster_path}`}
                      alt={item.title || item.name || ''}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center">
                      {isTV ? <Tv className="size-5 text-[#404040]" /> : <Film className="size-5 text-[#404040]" />}
                    </div>
                  )}
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-[#F5F5F5] truncate">
                    {item.title || item.name || 'Untitled'}
                  </p>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-[11px] text-[#606060]">
                      {item.release_date || item.first_air_date
                        ? new Date(item.release_date || item.first_air_date || '').getFullYear()
                        : ''}
                    </span>
                    <span className="text-[11px] text-[#606060] bg-white/[0.06] px-1.5 py-0.5 rounded uppercase">
                      {isTV ? 'TV' : 'Movie'}
                    </span>
                    {item.vote_average && item.vote_average > 0 && (
                      <span className="text-[11px] text-yellow-500">
                        ★ {item.vote_average.toFixed(1)}
                      </span>
                    )}
                  </div>
                  {isTV && (
                    <p className="text-[10px] text-sv-red/70 mt-0.5">Tap to select season &amp; episode</p>
                  )}
                </div>
              </button>
            )
          })}
        </div>
      </motion.div>
    </motion.div>
  )
}
