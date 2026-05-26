'use client';

import { useRef, useCallback, useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import ContentCard from './ContentCard';
import { RowSkeleton } from './ContentSkeleton';
import type { ContentItem } from '@/types/streaming';

interface ContentRowProps {
  title: string;
  items: ContentItem[];
  isLoading?: boolean;
  onItemClick: (item: ContentItem) => void;
  /** Stagger delay index for cascade entrance */
  index?: number;
}

export default function ContentRow({
  title,
  items,
  isLoading = false,
  onItemClick,
  index = 0,
}: ContentRowProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const checkScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 0);
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.addEventListener('scroll', checkScroll, { passive: true });
    window.addEventListener('resize', checkScroll);
    return () => {
      el.removeEventListener('scroll', checkScroll);
      window.removeEventListener('resize', checkScroll);
    };
  }, [checkScroll]);

  useEffect(() => {
    checkScroll();
  }, [items.length, checkScroll]);

  const scroll = useCallback((direction: 'left' | 'right') => {
    const el = scrollRef.current;
    if (!el) return;
    const scrollAmount = el.clientWidth * 0.75;
    el.scrollBy({
      left: direction === 'left' ? -scrollAmount : scrollAmount,
      behavior: 'smooth',
    });
  }, []);

  if (isLoading) {
    return <RowSkeleton />;
  }

  if (!items || items.length === 0) return null;

  return (
    <motion.section
      className="mb-8 group/row"
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        duration: 0.5,
        delay: Math.min(index * 0.06, 0.4),
        ease: [0.32, 0.72, 0, 1],
      }}
    >
      {/* Title */}
      <h2 className="text-lg font-bold text-[#F5F5F5] px-4 mb-4">
        {title}
      </h2>

      <div className="relative">
        {/* Left arrow */}
        {canScrollLeft && (
          <button
            onClick={() => scroll('left')}
            className="flex absolute -left-2 top-0 bottom-0 z-20 items-center justify-center w-12 bg-black/60 hover:bg-black/80 rounded-r-lg opacity-0 group-hover/row:opacity-100 transition-opacity duration-300 cursor-pointer"
            aria-label="Scroll left"
          >
            <ChevronLeft className="size-6 text-white" />
          </button>
        )}

        {/* Scroll container */}
        <div
          ref={scrollRef}
          className="flex gap-3 px-4 overflow-x-auto scroll-row"
        >
          {items.map((item) => (
            <div key={`${item.id}-${item.media_type}`} className="flex-shrink-0 w-[140px]">
              <ContentCard item={item} onClick={() => onItemClick(item)} />
            </div>
          ))}
        </div>

        {/* Right arrow */}
        {canScrollRight && (
          <button
            onClick={() => scroll('right')}
            className="flex absolute -right-2 top-0 bottom-0 z-20 items-center justify-center w-12 bg-black/60 hover:bg-black/80 rounded-l-lg opacity-0 group-hover/row:opacity-100 transition-opacity duration-300 cursor-pointer"
            aria-label="Scroll right"
          >
            <ChevronRight className="size-6 text-white" />
          </button>
        )}
      </div>
    </motion.section>
  );
}
