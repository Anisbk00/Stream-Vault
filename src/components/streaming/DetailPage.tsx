'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { motion } from 'framer-motion';
import {
  ArrowLeft,
  Play,
  Heart,
  Star,
  Clock,
  Calendar,
  Film,
  Tv,
  Share2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { ContentDetail, ContentItem, EpisodeDetail } from '@/types/streaming';
import {
  fetchContentDetail,
  fetchSeasonDetail,
  getImageUrl,
  getBackdropUrl,
} from '@/services/api';
import ContentRow from './ContentRow';
import CastCarousel from './CastCarousel';
import { DetailSkeleton, EpisodeListSkeleton } from './ContentSkeleton';
import DownloadButton from './DownloadButton';
import { useProgressStore } from '@/store';

interface DetailPageProps {
  contentId: string | number;
  mediaType: 'movie' | 'tv';
  onBack: () => void;
  onPlay: (
    contentId: string | number,
    mediaType: 'movie' | 'tv',
    season?: number,
    episode?: number
  ) => void;
  onNavigateItem?: (item: ContentItem) => void;
  isInWatchlist: (id: string | number) => boolean;
  onToggleWatchlist: (id: string | number) => void;
}

/* ── Helpers ──────────────────────────────────────────────── */

function getDisplayTitle(detail: ContentDetail): string {
  return (
    detail.title ||
    detail.name ||
    detail.original_title ||
    detail.original_name ||
    'Untitled'
  );
}

function getYear(detail: ContentDetail): string {
  const date = detail.release_date || detail.first_air_date;
  if (!date) return '';
  return new Date(date).getFullYear().toString();
}

function formatRuntime(minutes: number | undefined): string {
  if (!minutes) return '';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

function formatEpisodeRuntime(minutes: number | undefined): string {
  if (!minutes) return '';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

/* ── Component ────────────────────────────────────────────── */

export default function DetailPage({
  contentId,
  mediaType,
  onBack,
  onPlay,
  onNavigateItem,
  isInWatchlist,
  onToggleWatchlist,
}: DetailPageProps) {
  const [detail, setDetail] = useState<ContentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedSeason, setSelectedSeason] = useState(1);
  const [episodes, setEpisodes] = useState<EpisodeDetail[]>([]);
  const [episodesLoading, setEpisodesLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // Progress store — select raw array (stable reference from Zustand)
  const allProgress = useProgressStore((s) => s.progress);

  // Derive progress map outside the selector to avoid new-ref infinite loop
  const progressMap = useMemo(() => {
    const map = new Map<string, number>();
    for (const p of allProgress) {
      if (String(p.contentId) !== String(contentId)) continue;
      if (p.duration <= 0) continue;
      const key = `${p.season ?? 'x'}-${p.episode ?? 'x'}`;
      const pct = (p.progress / p.duration) * 100;
      if (!map.has(key) || map.get(key)! < pct) map.set(key, pct);
    }
    return map;
  }, [allProgress, contentId]);

  /* ── Fetch content detail ─────────────────────────────── */
  useEffect(() => {
    const controller = new AbortController();
    abortRef.current = controller;

    async function load() {
      setLoading(true);
      try {
        const data = await fetchContentDetail(contentId, mediaType, controller.signal);
        if (!controller.signal.aborted) setDetail(data);
      } catch {
        // Silently handle fetch errors; skeleton keeps showing
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }

    load();
    return () => {
      controller.abort();
    };
  }, [contentId, mediaType]);

  /* ── Fetch episodes when season changes ───────────────── */
  const loadEpisodes = useCallback(
    async (tvId: string | number, seasonNumber: number, signal?: AbortSignal) => {
      if (mediaType !== 'tv') return;
      setEpisodesLoading(true);
      try {
        const data = await fetchSeasonDetail(tvId, seasonNumber, signal);
        if (!signal?.aborted) setEpisodes(data);
      } catch {
        if (!signal?.aborted) setEpisodes([]);
      } finally {
        if (!signal?.aborted) setEpisodesLoading(false);
      }
    },
    [mediaType]
  );

  useEffect(() => {
    if (mediaType === 'tv') {
      const controller = new AbortController();
      loadEpisodes(contentId, selectedSeason, controller.signal);
      return () => controller.abort();
    }
  }, [mediaType, contentId, selectedSeason, loadEpisodes]);

  /* ── Derived values ───────────────────────────────────── */
  const title = detail ? getDisplayTitle(detail) : '';
  const year = detail ? getYear(detail) : '';
  const backdropUrl = detail ? getBackdropUrl(detail.backdrop_path) : '';
  const posterUrl = detail ? getImageUrl(detail.poster_path, 'w500') : '';
  const inWatchlist = isInWatchlist(contentId);
  const isTv = mediaType === 'tv';

  const similarItems: ContentItem[] = Array.isArray(detail?.similar?.results)
    ? detail.similar.results
        .slice(0, 15)
        .map((item) => ({ ...item, media_type: item.media_type || mediaType }))
    : [];

  const handleShare = async () => {
    const shareData = {
      title,
      text: detail?.tagline || detail?.overview || '',
      url: window.location.href,
    };
    try {
      if (navigator.share) {
        await navigator.share(shareData);
      } else {
        await navigator.clipboard.writeText(window.location.href);
      }
    } catch {
      // User cancelled or clipboard not available — silent fail
    }
  };

  /* ── Loading state ────────────────────────────────────── */
  if (loading) {
    return (
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.25 }}
      >
        <DetailSkeleton />
      </motion.div>
    );
  }

  if (!detail) return null;

  /* ── Staggered section animation variants ─────────────── */
  const sectionStagger = {
    container: {
      animate: { transition: { staggerChildren: 0.08, delayChildren: 0.15 } },
    },
    item: {
      initial: { opacity: 0, y: 20 },
      animate: {
        opacity: 1,
        y: 0,
        transition: { duration: 0.45, ease: [0.32, 0.72, 0, 1] },
      },
    },
  };

  /* ── Render ───────────────────────────────────────────── */
  return (
    <motion.div
      key={`detail-${contentId}`}
      initial={{ opacity: 1 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="bg-[#080808]"
    >
      {/* ── Back button (fixed) ──────────────────────── */}
      <motion.div
        initial={{ opacity: 0, x: -10 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ duration: 0.35, delay: 0.1, ease: [0.32, 0.72, 0, 1] }}
      >
        <Button
          onClick={onBack}
          size="icon"
          className="fixed left-4 z-50 w-11 h-11 rounded-full glass border-white/[0.1] hover:bg-white/[0.15] text-white cursor-pointer"
          style={{ top: 'max(0.75rem, env(safe-area-inset-top))' }}
          aria-label="Go back"
        >
          <ArrowLeft className="size-5" />
        </Button>
      </motion.div>

      {/* ── Hero backdrop ────────────────────────────── */}
      <motion.div
        className="relative w-full h-[50vh] overflow-hidden"
        style={{ marginTop: 'calc(-1 * env(safe-area-inset-top, 0px))' }}
        initial={{ opacity: 0, scale: 1.08 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.6, ease: [0.32, 0.72, 0, 1] }}
      >
        {backdropUrl && (
          <img
            src={backdropUrl}
            alt=""
            className="w-full h-full object-cover object-center"
          />
        )}
        {/* Gradient overlays */}
        <div className="absolute inset-0 hero-gradient-bottom" />
        <div className="absolute inset-0 hero-gradient-left" />

        {/* ── Content overlaid on backdrop ──────────── */}
        <motion.div
          className="absolute bottom-0 left-0 right-0 px-4 pb-4"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.2, ease: [0.32, 0.72, 0, 1] }}
        >
          <div className="max-w-7xl mx-auto flex flex-col items-start gap-4">
            {/* Poster — floating over backdrop (both mobile & desktop) */}
            <div className="w-[120px] flex-shrink-0 -mb-2 drop-shadow-2xl shadow-black">
              <img
                src={posterUrl}
                alt={title}
                className="w-full rounded-lg shadow-2xl shadow-black/80"
              />
            </div>

            {/* Quick metadata on backdrop */}
            <div className="flex-1 min-w-0">
              <h1 className="text-2xl font-bold text-[#F5F5F5] leading-tight mb-2">
                {title}
              </h1>
              {detail.tagline && (
                <p className="text-sm italic text-[#A0A0A0] mb-3 line-clamp-1">
                  &ldquo;{detail.tagline}&rdquo;
                </p>
              )}
            </div>
          </div>
        </motion.div>
      </motion.div>

      {/* ── Main content body ────────────────────────── */}
      <motion.div
        className="max-w-7xl mx-auto px-4 pt-4 pb-12"
        variants={sectionStagger.container}
        initial="initial"
        animate="animate"
      >
        {/* ── Metadata section ──────────────────────── */}
        <motion.div className="flex flex-col gap-4 mb-8" variants={sectionStagger.item}>
          {/* Spacer on desktop (poster already shown on backdrop) */}
          <div className="hidden" />

          <div className="flex-1 space-y-4">
            {/* Year | Duration/Seasons | Rating | Score */}
            <div className="flex flex-wrap items-center gap-3 text-sm text-[#A0A0A0]">
              {year && (
                <span className="flex items-center gap-1.5">
                  <Calendar className="size-3.5" />
                  {year}
                </span>
              )}

              {isTv && detail.number_of_seasons ? (
                <span className="flex items-center gap-1.5">
                  <Tv className="size-3.5" />
                  {detail.number_of_seasons}{' '}
                  {detail.number_of_seasons === 1 ? 'Season' : 'Seasons'}
                </span>
              ) : (
                detail.runtime && (
                  <span className="flex items-center gap-1.5">
                    <Clock className="size-3.5" />
                    {formatRuntime(detail.runtime)}
                  </span>
                )
              )}

              {detail.vote_average && detail.vote_average > 0 && (
                <span className="flex items-center gap-1.5 text-sv-gold">
                  <Star className="size-3.5 fill-sv-gold" />
                  {detail.vote_average.toFixed(1)}
                </span>
              )}

              {isTv && detail.number_of_episodes ? (
                <span className="text-xs text-[#606060]">
                  {detail.number_of_episodes} episodes
                </span>
              ) : null}
            </div>

            {/* Genre badges */}
            {detail.genres && detail.genres.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {detail.genres.map((genre) => (
                  <span
                    key={genre.id}
                    className="bg-white/10 rounded-full px-3 py-1 text-sm text-[#F5F5F5] hover:bg-white/20 transition-colors duration-200 cursor-default"
                  >
                    {genre.name}
                  </span>
                ))}
              </div>
            )}

            {/* Overview */}
            {detail.overview && (
              <p className="text-sm text-[#A0A0A0] leading-relaxed max-w-3xl">
                {detail.overview}
              </p>
            )}

            {/* ── Action buttons ──────────────────────── */}
            <div className="flex items-center gap-3 pt-2 flex-wrap">
              <motion.div whileTap={{ scale: 0.95 }} transition={{ type: 'spring', damping: 20, stiffness: 400 }}>
                <Button
                  onClick={() => {
                    if (isTv) {
                      onPlay(contentId, mediaType, selectedSeason, 1);
                    } else {
                      onPlay(contentId, mediaType);
                    }
                  }}
                  className="bg-sv-red hover:bg-sv-red-hover text-white font-semibold px-6 h-11 rounded-lg cursor-pointer"
                >
                  <Play className="size-5 fill-white" />
                  Play
                </Button>
              </motion.div>

              <motion.div whileTap={{ scale: 0.95 }} transition={{ type: 'spring', damping: 20, stiffness: 400 }}>
                <Button
                  variant="outline"
                  onClick={() => onToggleWatchlist(contentId)}
                  className={`h-11 px-5 rounded-lg border-white/[0.15] hover:bg-white/[0.1] cursor-pointer ${
                    inWatchlist
                      ? 'bg-sv-red/20 border-sv-red text-sv-red'
                      : 'text-[#F5F5F5]'
                  }`}
                >
                  <Heart
                    className={`size-5 ${inWatchlist ? 'fill-sv-red text-sv-red' : ''}`}
                  />
                  {inWatchlist ? 'In List' : 'Watchlist'}
                </Button>
              </motion.div>

              <motion.div whileTap={{ scale: 0.95 }} transition={{ type: 'spring', damping: 20, stiffness: 400 }}>
                <Button
                  variant="outline"
                  onClick={handleShare}
                  className="h-11 px-5 rounded-lg border-white/[0.15] hover:bg-white/[0.1] text-[#F5F5F5] cursor-pointer"
                >
                  <Share2 className="size-5" />
                  Share
                </Button>
              </motion.div>

              {!isTv && (
                <DownloadButton
                  contentId={contentId}
                  mediaType={mediaType}
                  title={title}
                  posterUrl={posterUrl}
                  year={year}
                />
              )}
            </div>
          </div>
        </motion.div>

        {/* ── Cast section ────────────────────────────── */}
        {detail.credits?.cast && detail.credits.cast.length > 0 && (
          <motion.section className="mb-8" variants={sectionStagger.item}>
            <CastCarousel cast={detail.credits.cast} />
          </motion.section>
        )}

        {/* ── TV Series: Season selector + Episodes ──── */}
        {isTv && detail.seasons && detail.seasons.length > 0 && (
          <motion.section className="mb-10" variants={sectionStagger.item}>
            {/* Season selector */}
            <div className="mb-4">
              <h2 className="text-lg font-bold text-[#F5F5F5] mb-3">
                Episodes
              </h2>
              <div className="flex gap-2 overflow-x-auto scroll-row pb-2">
                {detail.seasons
                  .filter((s) => s.season_number > 0)
                  .map((season) => (
                    <motion.div
                      key={season.id}
                      whileTap={{ scale: 0.94 }}
                      transition={{ type: 'spring', damping: 20, stiffness: 400 }}
                    >
                      <Button
                        onClick={() => setSelectedSeason(season.season_number)}
                        variant={
                          selectedSeason === season.season_number
                            ? 'default'
                            : 'outline'
                        }
                        className={`flex-shrink-0 rounded-lg cursor-pointer transition-colors duration-200 ${
                          selectedSeason === season.season_number
                            ? 'bg-sv-red hover:bg-sv-red-hover text-white'
                            : 'border-white/[0.15] text-[#A0A0A0] hover:bg-white/[0.08] hover:text-[#F5F5F5]'
                        }`}
                      >
                        {season.name}
                      </Button>
                    </motion.div>
                  ))}
              </div>
            </div>

            {/* Episode list — Netflix-style open layout */}
            <div className="space-y-2">
              {episodesLoading ? (
                <EpisodeListSkeleton />
              ) : episodes.length > 0 ? (
                episodes.map((ep) => {
                  // Get real-time progress for this episode (O(1) map lookup)
                  const epKey = `${selectedSeason}-${ep.episode_number}`;
                  const progressPercent = progressMap.get(epKey) ?? 0;

                  return (
                    <motion.div
                      key={ep.id}
                      className="relative flex gap-4 p-3 rounded-lg cursor-pointer group hover:bg-white/[0.06] transition-colors duration-200"
                      onClick={() =>
                        onPlay(contentId, mediaType, selectedSeason, ep.episode_number)
                      }
                      whileTap={{ scale: 0.99 }}
                      transition={{ type: 'spring', damping: 25, stiffness: 400 }}
                    >
                      {/* Episode thumbnail */}
                      <div className="w-[160px] aspect-video rounded-md overflow-hidden flex-shrink-0 bg-[#1a1a1a] relative">
                        {ep.still_path ? (
                          <img
                            src={getImageUrl(ep.still_path, 'w300')}
                            alt={ep.name}
                            className="w-full h-full object-cover"
                            loading="lazy"
                          />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center bg-[#1a1a1a]">
                            <Film className="size-6 text-[#404040]" />
                          </div>
                        )}
                        {/* Play overlay on hover */}
                        <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity duration-300 flex items-center justify-center">
                          <div className="w-10 h-10 rounded-full bg-sv-red flex items-center justify-center">
                            <Play className="size-5 fill-white text-white ml-0.5" />
                          </div>
                        </div>
                        {/* Runtime overlay */}
                        {ep.runtime && (
                          <div className="absolute bottom-1.5 right-1.5 bg-black/80 text-[10px] text-white px-1.5 py-0.5 rounded font-medium">
                            {formatEpisodeRuntime(ep.runtime)}
                          </div>
                        )}
                        {/* Episode number badge */}
                        <div className="absolute top-1.5 left-1.5 bg-black/80 text-[10px] text-white/80 px-1.5 py-0.5 rounded font-medium">
                          {ep.episode_number}
                        </div>
                      </div>

                      {/* Episode info */}
                      <div className="flex-1 min-w-0 py-0.5">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <h4 className="text-sm font-semibold text-[#F5F5F5] leading-tight line-clamp-2">
                              {ep.name}
                            </h4>
                          </div>
                          <div className="flex items-center gap-2 flex-shrink-0 mt-0.5">
                            {ep.vote_average && ep.vote_average > 0 && (
                              <span className="flex items-center gap-1 text-xs text-sv-gold">
                                <Star className="size-3 fill-sv-gold" />
                                {ep.vote_average.toFixed(1)}
                              </span>
                            )}
                            <DownloadButton
                              contentId={contentId}
                              mediaType="tv"
                              title={`${title} E${ep.episode_number}`}
                              posterUrl={posterUrl}
                              year={year}
                              season={selectedSeason}
                              episode={ep.episode_number}
                              compact
                            />
                          </div>
                        </div>
                        {ep.air_date && (
                          <p className="text-xs text-[#606060] mt-1">
                            {new Date(ep.air_date).toLocaleDateString('en-US', {
                              month: 'short',
                              day: 'numeric',
                              year: 'numeric',
                            })}
                          </p>
                        )}
                        {ep.overview && (
                          <p className="text-xs text-[#A0A0A0] leading-relaxed mt-2 line-clamp-3">
                            {ep.overview}
                          </p>
                        )}
                      </div>

                      {/* ── Real-time red progress bar (Netflix-style) ── */}
                      {progressPercent > 0 && (
                        <div className="absolute bottom-0 left-3 right-3 h-[3px] rounded-full bg-white/[0.06] overflow-hidden">
                          <div
                            className="absolute left-0 top-0 h-full rounded-full bg-sv-red transition-all duration-500"
                            style={{ width: `${Math.min(progressPercent, 100)}%` }}
                          />
                        </div>
                      )}
                    </motion.div>
                  );
                })
              ) : (
                <div className="text-center py-12">
                  <p className="text-[#606060] text-sm">
                    No episodes available for this season.
                  </p>
                </div>
              )}
            </div>
          </motion.section>
        )}

        {/* ── Similar content — MOVIES ONLY ──────────── */}
        {!isTv && similarItems.length > 0 && onNavigateItem && (
          <motion.section className="mb-4" variants={sectionStagger.item}>
            <ContentRow
              title="Similar"
              items={similarItems}
              onItemClick={onNavigateItem}
            />
          </motion.section>
        )}
      </motion.div>
    </motion.div>
  );
}
