'use client';

import { motion, AnimatePresence } from 'framer-motion';
import { Heart, X, Film, Play } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useWatchlistStore } from '@/store';
import type { ContentItem } from '@/types/streaming';
import { getImageUrl } from '@/services/api';

interface WatchlistPageProps {
  onNavigate: (page: string, id?: string | number) => void;
  onItemClick: (item: ContentItem) => void;
  onRemove: (id: string | number) => void;
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
  if (item.first_air_date) return 'tv';
  if (item.release_date) return 'movie';
  return 'movie';
}

const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.06,
    },
  },
};

const itemVariants = {
  hidden: { opacity: 0, y: 24, scale: 0.95 },
  visible: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: {
      type: 'spring',
      damping: 25,
      stiffness: 300,
      mass: 0.8,
    },
  },
  exit: {
    opacity: 0,
    scale: 0.85,
    transition: { duration: 0.2 },
  },
};

export default function WatchlistPage({ onNavigate, onItemClick, onRemove }: WatchlistPageProps) {
  const items = useWatchlistStore((s) => s.items);

  return (
    <section className="min-h-[calc(100dvh-1rem)] bg-[#080808]">
      {/* Page header */}
      <div className="px-4 pt-8 mb-6">
        <motion.div
          initial={{ opacity: 0, y: -12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
          className="flex items-center gap-3"
        >
          <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-sv-red/15">
            <Heart className="size-5 text-sv-red fill-sv-red" />
          </div>
          <h1 className="text-2xl font-bold text-[#F5F5F5]">My List</h1>
          {items.length > 0 && (
            <Badge
              variant="secondary"
              className="bg-white/10 text-[#A0A0A0] text-xs font-semibold px-2.5 py-0.5 rounded-full"
            >
              {items.length}
            </Badge>
          )}
        </motion.div>
      </div>

      {/* Empty state */}
      {items.length === 0 && (
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.15 }}
          className="flex flex-col items-center justify-center text-center px-6 py-20 md:py-32"
        >
          <div className="relative mb-6">
            <div className="flex items-center justify-center w-24 h-24 rounded-full bg-white/[0.05]">
              <Heart className="size-10 text-[#606060]" />
            </div>
            <div className="absolute -top-1 -right-1 flex items-center justify-center w-8 h-8 rounded-full bg-white/[0.05]">
              <Film className="size-4 text-[#606060]" />
            </div>
          </div>

          <h2 className="text-xl font-semibold text-[#F5F5F5] mb-2">
            Your list is empty
          </h2>
          <p className="text-sm text-[#606060] max-w-sm mb-8 leading-relaxed">
            Browse content and add it to your list to keep track of movies and series you want to watch.
          </p>

          <Button
            onClick={() => onNavigate('browse')}
            className="bg-sv-red hover:bg-sv-red-hover text-white font-semibold h-11 px-8 rounded-lg text-sm"
          >
            <Play className="size-4 mr-2 fill-white" />
            Browse Content
          </Button>
        </motion.div>
      )}

      {/* Watchlist grid */}
      {items.length > 0 && (
        <AnimatePresence mode="wait">
          <motion.div
            key="watchlist-grid"
            variants={containerVariants}
            initial="hidden"
            animate="visible"
            className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3 px-4"
          >
            {items.map((item) => {
              const title = getDisplayTitle(item);
              const year = getYear(item);
              const mediaType = getMediaType(item);
              const posterUrl = getImageUrl(item.poster_path);

              return (
                <motion.div
                  key={String(item.id)}
                  variants={itemVariants}
                  exit="exit"
                  className="relative group"
                >
                  {/* Remove button */}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onRemove(item.id);
                    }}
                    className="absolute top-2 right-2 z-20 flex items-center justify-center w-7 h-7 rounded-full bg-black/70 backdrop-blur-sm text-[#A0A0A0] hover:text-white hover:bg-sv-red/90 transition-all duration-200 opacity-0 group-hover:opacity-100 focus:opacity-100 cursor-pointer"
                    aria-label={`Remove ${title} from list`}
                  >
                    <X className="size-3.5" />
                  </button>

                  {/* Card content */}
                  <div
                    onClick={() => onItemClick(item)}
                    className="relative cursor-pointer rounded-lg overflow-hidden"
                  >
                    {/* Glow border on hover */}
                    <div className="absolute inset-0 rounded-lg border border-transparent group-hover:border-white/[0.15] group-hover:shadow-[0_8px_32px_rgba(0,0,0,0.6),0_0_0_1px_rgba(255,255,255,0.1)] transition-all duration-300 z-10 pointer-events-none" />

                    {/* Poster */}
                    <div className="relative aspect-[2/3] bg-[#1a1a1a]">
                      <img
                        src={posterUrl}
                        alt={title}
                        className="w-full h-full object-cover"
                        loading="lazy"
                      />

                      {/* Bottom gradient */}
                      <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/30 to-transparent" />

                      {/* Media type badge */}
                      <div className="absolute top-2 left-2 z-10">
                        <Badge
                          variant="secondary"
                          className="bg-black/70 text-[#F5F5F5] text-[9px] uppercase tracking-wider font-semibold backdrop-blur-sm border-white/[0.1]"
                        >
                          {mediaType === 'tv' ? 'TV' : 'Film'}
                        </Badge>
                      </div>

                      {/* Bottom info */}
                      <div className="absolute bottom-0 left-0 right-0 p-3 z-10">
                        <h3 className="text-sm font-semibold text-white leading-tight line-clamp-2 mb-0.5">
                          {title}
                        </h3>
                        {year && (
                          <span className="text-xs text-[#A0A0A0]">{year}</span>
                        )}
                      </div>
                    </div>
                  </div>
                </motion.div>
              );
            })}
          </motion.div>
        </AnimatePresence>
      )}
    </section>
  );
}
