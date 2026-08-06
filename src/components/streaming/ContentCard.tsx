'use client';

import { memo, useState } from 'react';
import { motion } from 'framer-motion';
import { Star, Tv, Film } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import type { ContentItem } from '@/types/streaming';
import { getImageUrl } from '@/services/api';
import DownloadBadge from './DownloadBadge';
import { useProgressStore } from '@/store';

interface ContentCardProps {
  item: ContentItem;
  onClick: () => void;
}

function getDisplayTitle(item: ContentItem): string {
  return item.title || item.name || item.original_title || item.original_name || 'Untitled';
}

function getYear(item: ContentItem): string {
  const date = item.release_date || item.first_air_date;
  if (!date) return '';
  return new Date(date).getFullYear().toString();
}

function getMediaType(item: ContentItem): 'movie' | 'tv' | string {
  if (item.media_type === 'movie' || item.media_type === 'tv') return item.media_type;
  // Fallback: tv series have first_air_date, movies have release_date
  if (item.first_air_date) return 'tv';
  if (item.release_date) return 'movie';
  return 'movie';
}

const ContentCard = memo(function ContentCard({ item, onClick }: ContentCardProps) {
  const [imageLoaded, setImageLoaded] = useState(false);
  const title = getDisplayTitle(item);
  const year = getYear(item);
  const rating = item.vote_average ?? 0;
  const mediaType = getMediaType(item);
  const posterUrl = getImageUrl(item.poster_path);

  // Granular progress selector — only re-renders when THIS item's progress changes
  const itemId = String(item.id);
  const progressPercent = useProgressStore((s) => {
    const movieProgress = s.progress.find(
      (p) => String(p.contentId) === itemId && p.season === undefined && p.episode === undefined
    );
    if (movieProgress && movieProgress.duration > 0) {
      return (movieProgress.progress / movieProgress.duration) * 100;
    }
    const anyProgress = s.progress.find(
      (p) => String(p.contentId) === itemId
    );
    if (anyProgress && anyProgress.duration > 0) {
      return (anyProgress.progress / anyProgress.duration) * 100;
    }
    return 0;
  });

  return (
    <motion.div
      className="relative cursor-pointer rounded-lg overflow-hidden group flex-shrink-0"
      whileHover={{ scale: 1.04, y: -4 }}
      whileTap={{ scale: 0.95 }}
      transition={{
        type: 'spring',
        damping: 25,
        stiffness: 350,
        mass: 0.8,
      }}
      onClick={onClick}
    >
      {/* Glow border on hover */}
      <div className="absolute inset-0 rounded-lg border border-transparent group-hover:border-white/[0.15] group-hover:shadow-[0_8px_32px_rgba(0,0,0,0.6),0_0_0_1px_rgba(255,255,255,0.1)] transition-all duration-300 z-10 pointer-events-none" />

      {/* Poster Image */}
      <div className="relative aspect-[2/3] bg-[#1a1a1a]">
        {!imageLoaded && (
          <div className="absolute inset-0 skeleton-shimmer rounded-lg" />
        )}
        <img
          src={posterUrl}
          alt={title}
          className={`w-full h-full object-cover transition-all duration-500 ${
            imageLoaded ? 'opacity-100' : 'opacity-0'
          }`}
          loading="lazy"
          decoding="async"
          onLoad={() => setImageLoaded(true)}
          onError={() => setImageLoaded(true)}
        />

        {/* Bottom gradient overlay */}
        <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/30 to-transparent" />

        {/* Top badges row - type + rating on same line */}
        <div className="absolute top-2 left-2 z-10 flex items-center gap-1.5">
          <Badge
            variant="secondary"
            className="bg-black/70 text-[#F5F5F5] text-[9px] uppercase tracking-wider font-semibold backdrop-blur-sm border-white/[0.1]"
          >
            {mediaType === 'tv' ? (
              <Tv className="size-2.5 mr-0.5" />
            ) : (
              <Film className="size-2.5 mr-0.5" />
            )}
            {mediaType === 'tv' ? 'Serie' : 'Film'}
          </Badge>
          {rating > 0 && (
            <Badge
              variant="secondary"
              className="bg-black/70 text-sv-gold text-[10px] font-bold backdrop-blur-sm border-white/[0.1]"
            >
              <Star className="size-3 mr-1 fill-sv-gold text-sv-gold" />
              {rating.toFixed(1)}
            </Badge>
          )}
        </div>

        {/* Download badge - bottom right */}
        <DownloadBadge contentId={item.id} />

        {/* Bottom content - title & year */}
        <div className="absolute bottom-0 left-0 right-0 p-3 z-10">
          <h3 className="text-sm font-semibold text-white leading-tight line-clamp-2 mb-0.5">
            {title}
          </h3>
          <div className="flex items-center gap-2">
            {year && (
              <span className="text-xs text-[#A0A0A0]">{year}</span>
            )}
          </div>
        </div>

        {/* ── Real-time red progress bar (Netflix-style) ── */}
        {progressPercent > 0 && (
          <div className="absolute bottom-0 left-0 right-0 h-[3px] z-20">
            <div
              className="h-full bg-sv-red transition-all duration-500"
              style={{ width: `${Math.min(progressPercent, 100)}%` }}
            />
          </div>
        )}
      </div>
    </motion.div>
  );
});

export default ContentCard;
