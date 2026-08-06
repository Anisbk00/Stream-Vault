'use client';

import { useRef } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { CastMember } from '@/types/streaming';
import { getImageUrl } from '@/services/api';

interface CastCarouselProps {
  cast: CastMember[];
}

export default function CastCarousel({ cast }: CastCarouselProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  const scroll = (direction: 'left' | 'right') => {
    const el = scrollRef.current;
    if (!el) return;
    const scrollAmount = el.clientWidth * 0.7;
    el.scrollBy({
      left: direction === 'left' ? -scrollAmount : scrollAmount,
      behavior: 'smooth',
    });
  };

  if (!cast || cast.length === 0) return null;

  return (
    <section className="mb-8">
      <div className="flex items-center justify-between px-4 mb-4">
        <h2 className="text-lg font-bold text-[#F5F5F5]">Cast</h2>
        <div className="flex gap-2">
          <button
            onClick={() => scroll('left')}
            className="w-8 h-8 rounded-full border border-white/[0.15] flex items-center justify-center hover:bg-white/[0.1] transition-colors cursor-pointer"
            aria-label="Scroll cast left"
          >
            <ChevronLeft className="size-4 text-[#A0A0A0]" />
          </button>
          <button
            onClick={() => scroll('right')}
            className="w-8 h-8 rounded-full border border-white/[0.15] flex items-center justify-center hover:bg-white/[0.1] transition-colors cursor-pointer"
            aria-label="Scroll cast right"
          >
            <ChevronRight className="size-4 text-[#A0A0A0]" />
          </button>
        </div>
      </div>

      <div
        ref={scrollRef}
        className="flex gap-4 px-4 overflow-x-auto scroll-row pb-2"
      >
        {cast.map((member) => {
          const avatarUrl = getImageUrl(member.profile_path, 'w185');
          const hasAvatar = !!member.profile_path;

          return (
            <div
              key={member.id}
              className="flex-shrink-0 flex flex-col items-center gap-2 w-[80px]"
            >
              {/* Avatar */}
              <div className="w-16 h-16 rounded-full overflow-hidden border border-white/[0.1] bg-[#1a1a1a] flex-shrink-0">
                {hasAvatar ? (
                  <img
                    src={avatarUrl}
                    alt={member.name}
                    className="w-full h-full object-cover"
                    loading="lazy"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center bg-[#222]">
                    <span className="text-lg font-semibold text-[#606060]">
                      {member.name.charAt(0).toUpperCase()}
                    </span>
                  </div>
                )}
              </div>

              {/* Name */}
              <div className="text-center">
                <p className="text-xs font-medium text-[#F5F5F5] leading-tight line-clamp-1">
                  {member.name}
                </p>
                <p className="text-[10px] text-[#606060] leading-tight line-clamp-1 mt-0.5">
                  {member.character}
                </p>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
