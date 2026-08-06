'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Play, Plus, Heart, Info, Star } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { HeroSkeleton } from './ContentSkeleton';
import type { ContentItem } from '@/types/streaming';
import { getBackdropUrl } from '@/services/api';

interface HeroSliderProps {
  items: ContentItem[];
  isLoading?: boolean;
  onPlay: (item: ContentItem) => void;
  onInfo: (item: ContentItem) => void;
  onAddList: (item: ContentItem) => void;
  isInList: (id: string | number) => boolean;
}

function getDisplayTitle(item: ContentItem): string {
  return item.title || item.name || item.original_title || item.original_name || 'Untitled';
}

function getYear(item: ContentItem): string {
  const date = item.release_date || item.first_air_date;
  if (!date) return '';
  return new Date(date).getFullYear().toString();
}

function truncate(text: string | undefined, maxLen: number): string {
  if (!text) return '';
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen).trim() + '…';
}

export default function HeroSlider({
  items,
  isLoading = false,
  onPlay,
  onInfo,
  onAddList,
  isInList,
}: HeroSliderProps) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isPaused, setIsPaused] = useState(false);

  // Auto-rotate every 8 seconds
  useEffect(() => {
    if (isLoading || isPaused || items.length <= 1) return;

    const timer = setInterval(() => {
      setCurrentIndex((prev) => (prev + 1) % items.length);
    }, 8000);

    return () => clearInterval(timer);
  }, [isLoading, isPaused, items.length]);

  const resumeTimerRef = useRef<ReturnType<typeof setTimeout>>();

  const goToSlide = useCallback((index: number) => {
    setCurrentIndex(index);
    setIsPaused(true);
    // Resume auto-play after 10 seconds
    if (resumeTimerRef.current) clearTimeout(resumeTimerRef.current);
    resumeTimerRef.current = setTimeout(() => setIsPaused(false), 10000);
  }, []);

  // Cleanup resume timer on unmount
  useEffect(() => {
    return () => {
      if (resumeTimerRef.current) clearTimeout(resumeTimerRef.current);
    };
  }, []);

  const goNext = useCallback(() => {
    goToSlide((currentIndex + 1) % items.length);
  }, [currentIndex, items.length, goToSlide]);

  const goPrev = useCallback(() => {
    goToSlide((currentIndex - 1 + items.length) % items.length);
  }, [currentIndex, items.length, goToSlide]);

  if (isLoading) {
    return <HeroSkeleton />;
  }

  if (!items || items.length === 0) return null;

  const currentItem = items[currentIndex];
  const title = getDisplayTitle(currentItem);
  const year = getYear(currentItem);
  const rating = currentItem.vote_average ?? 0;
  const overview = truncate(currentItem.overview, 180);
  const backdropUrl = getBackdropUrl(currentItem.backdrop_path);
  const inList = isInList(currentItem.id);

  return (
    <section
      className="relative w-full min-h-[50vh] overflow-hidden"
      onMouseEnter={() => setIsPaused(true)}
      onMouseLeave={() => setIsPaused(false)}
    >
      {/* Backdrop images with crossfade */}
      <AnimatePresence mode="sync" initial={false}>
        <motion.div
          key={currentIndex}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.8, ease: 'easeInOut' }}
          className="absolute inset-0"
        >
          {backdropUrl ? (
            <img
              src={backdropUrl}
              alt={title}
              fetchPriority="high"
              className="w-full h-full object-cover"
            />
          ) : (
            <div className="w-full h-full bg-[#111111]" />
          )}
        </motion.div>
      </AnimatePresence>

      {/* Gradient overlays */}
      <div className="absolute inset-0 hero-gradient-bottom z-[1]" />
      <div className="absolute inset-0 hero-gradient-left z-[1]" />

      {/* Content */}
      <AnimatePresence mode="sync" initial={false}>
        <motion.div
          key={currentIndex}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.3, delay: 0.1 }}
          className="absolute bottom-16 left-4 right-4 z-[2] max-w-2xl"
        >
          {/* Genre badges */}
          <div className="flex items-center gap-2 mb-3 animate-hero-fade">
            {rating > 0 && (
              <Badge
                variant="secondary"
                className="bg-sv-gold/20 text-sv-gold border-sv-gold/30 text-xs font-bold"
              >
                <Star className="size-3 mr-1 fill-sv-gold" />
                {rating.toFixed(1)}
              </Badge>
            )}
            {year && (
              <Badge
                variant="secondary"
                className="bg-white/10 text-[#A0A0A0] border-white/[0.1] text-xs"
              >
                {year}
              </Badge>
            )}
          </div>

          {/* Title */}
          <h1 className="text-3xl font-extrabold text-white leading-[1.1] mb-3 animate-hero-fade">
            {title}
          </h1>

          {/* Overview */}
          {overview && (
            <p className="text-sm text-[#A0A0A0] leading-relaxed mb-6 line-clamp-3 animate-hero-fade-delay-1">
              {overview}
            </p>
          )}

          {/* Action buttons */}
          <div className="flex flex-wrap gap-3 animate-hero-fade-delay-2">
            <Button
              onClick={() => onPlay(currentItem)}
              className="bg-sv-red hover:bg-sv-red-hover text-white font-semibold h-11 px-6 rounded-lg text-sm"
            >
              <Play className="size-5 fill-white" />
              Play
            </Button>

            <Button
              variant="outline"
              onClick={() => onAddList(currentItem)}
              className="bg-white/10 hover:bg-white/20 border-white/[0.2] text-white h-11 px-6 rounded-lg text-sm backdrop-blur-sm"
            >
              {inList ? (
                <Heart className="size-5 fill-sv-red text-sv-red" />
              ) : (
                <Plus className="size-5" />
              )}
              {inList ? 'In List' : 'My List'}
            </Button>

            <Button
              variant="outline"
              onClick={() => onInfo(currentItem)}
              className="bg-white/10 hover:bg-white/20 border-white/[0.2] text-white h-11 px-6 rounded-lg text-sm backdrop-blur-sm"
            >
              <Info className="size-5" />
              More Info
            </Button>
          </div>
        </motion.div>
      </AnimatePresence>

      {/* Navigation dots */}
      {items.length > 1 && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-[3] flex items-center gap-2">
          {items.map((_, index) => (
            <button
              key={index}
              onClick={() => goToSlide(index)}
              className={`
                h-1 rounded-full transition-all duration-300 cursor-pointer
                ${
                  index === currentIndex
                    ? 'w-8 bg-white'
                    : 'w-2 bg-white/40 hover:bg-white/60'
                }
              `}
              aria-label={`Go to slide ${index + 1}`}
              aria-current={index === currentIndex ? 'true' : undefined}
            />
          ))}
        </div>
      )}
    </section>
  );
}
