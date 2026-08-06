'use client';

import type { ContentItem } from '@/types/streaming';

interface GenreChipsProps {
  genres: { id: number; name: string }[];
  selected?: number;
  onSelect: (id: number) => void;
}

export default function GenreChips({ genres, selected, onSelect }: GenreChipsProps) {
  if (!genres || genres.length === 0) return null;

  return (
    <div className="flex gap-2 overflow-x-auto scroll-row px-4 pb-2 scrollbar-none">
      {genres.map((genre) => {
        const isActive = selected === genre.id;

        return (
          <button
            key={genre.id}
            onClick={() => onSelect(genre.id)}
            className={`
              genre-chip flex-shrink-0 px-4 py-1.5 rounded-full text-sm font-medium
              border transition-all duration-200 cursor-pointer whitespace-nowrap
              ${
                isActive
                  ? 'bg-sv-red border-sv-red text-white'
                  : 'bg-transparent border-white/[0.15] text-[#A0A0A0] hover:border-sv-red hover:text-sv-red'
              }
            `}
          >
            {genre.name}
          </button>
        );
      })}
    </div>
  );
}
