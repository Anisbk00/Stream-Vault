'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Search, X, TrendingUp, Star, Film, Tv } from 'lucide-react';
import { searchContent, getImageUrl } from '@/services/api';
import { SearchGridSkeleton } from './ContentSkeleton';
import type { ContentItem } from '@/types/streaming';
import { useUIStore } from '@/store';
import { useNavigationStore } from '@/store';

interface SearchOverlayProps {
  isOpen: boolean;
  onClose: () => void;
  onNavigate: (page: string, id?: string | number) => void;
  onItemClick?: (item: ContentItem) => void;
  /** When restoring from a back-navigation, seed the overlay with previous state */
  restoreQuery?: string;
  restoreResults?: ContentItem[];
  /** Called once after restore has been consumed so the parent can clear it */
  onRestoreConsumed?: () => void;
}

const TRENDING_SEARCHES = [
  'Action', 'Comedy', 'Drama', 'Sci-Fi', 'Thriller',
  'Horror', 'Romance', 'Animation', 'Documentary',
];

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

export default function SearchOverlay({ isOpen, onClose, onNavigate, onItemClick, restoreQuery, restoreResults, onRestoreConsumed }: SearchOverlayProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ContentItem[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  const focusTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const abortRef = useRef<AbortController | null>(null);
  const restoreConsumedRef = useRef(false);

  // Focus input when opening
  useEffect(() => {
    if (isOpen) {
      // Restore saved search state if coming back from detail page
      if (restoreQuery && restoreResults && !restoreConsumedRef.current) {
        setQuery(restoreQuery);
        setResults(restoreResults);
        setIsSearching(false);
        restoreConsumedRef.current = true;
        onRestoreConsumed?.();
      } else {
        // Normal open — clear state
        setQuery('');
        setResults([]);
        setIsSearching(false);
        restoreConsumedRef.current = false;
      }
      focusTimerRef.current = setTimeout(() => inputRef.current?.focus(), 100);
    } else {
      if (focusTimerRef.current) clearTimeout(focusTimerRef.current);
      if (abortRef.current) abortRef.current.abort();
      // Don't clear query/results on close — they might be saved for restore
      if (debounceRef.current) clearTimeout(debounceRef.current);
    }
    return () => {
      if (focusTimerRef.current) clearTimeout(focusTimerRef.current);
    };
  }, [isOpen, restoreQuery, restoreResults, onRestoreConsumed]);

  // NOTE: Body scroll lock is NOT needed here.
  // The root layout sets overflow:hidden on body via React inline style.
  // The overlay is fixed inset-0 and manages its own internal scroll.
  // Previously, manipulating document.body.style.overflow conflicted with
  // React's style management and could remove the layout's overflow:hidden.

  // Debounced search with AbortController
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (abortRef.current) abortRef.current.abort();

    if (!query.trim()) {
      setResults([]);
      setIsSearching(false);
      return;
    }

    debounceRef.current = setTimeout(async () => {
      const controller = new AbortController();
      abortRef.current = controller;
      setIsSearching(true);
      try {
        const data = await searchContent(query, 1, controller.signal);
        if (!controller.signal.aborted) setResults(data);
      } catch {
        if (!controller.signal.aborted) setResults([]);
      } finally {
        if (!controller.signal.aborted) setIsSearching(false);
      }
    }, 300);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (abortRef.current) abortRef.current.abort();
    };
  }, [query]);

  const handleTrendingClick = useCallback((term: string) => {
    setQuery(term);
  }, []);

  const handleResultClick = (item: ContentItem) => {
    // Save search state to store BEFORE closing so back-navigation can restore it
    if (query.trim() && results.length > 0) {
      useUIStore.getState().saveSearchState(query, results);
      useNavigationStore.getState().setNavigatedFromSearch(true);
    }
    onClose();
    if (onItemClick) {
      onItemClick(item);
    } else {
      onNavigate('detail', item.id);
    }
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0, y: -30, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -20, scale: 0.98 }}
          transition={{ type: 'spring', damping: 28, stiffness: 300, mass: 0.8 }}
          className="fixed inset-0 z-[60] bg-[#080808] safe-top"
        >
          {/* Search header */}
          <div className="sticky top-0 z-10 glass border-b border-white/[0.08]">
            <div className="flex items-center gap-3 px-4 py-4 max-w-4xl mx-auto">
              <Search className="size-5 text-[#A0A0A0] flex-shrink-0" />
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search movies, series..."
                className="flex-1 bg-transparent text-lg text-[#F5F5F5] placeholder:text-[#606060] outline-none"
              />
              <button
                onClick={onClose}
                className="w-9 h-9 flex items-center justify-center rounded-full hover:bg-white/[0.1] transition-colors cursor-pointer"
                aria-label="Close search"
              >
                <X className="size-5 text-[#F5F5F5]" />
              </button>
            </div>
          </div>

          {/* Content */}
          <div className="px-4 py-6 max-w-4xl mx-auto overflow-y-auto h-[calc(100%-73px)] momentum-scroll">
            {/* Trending searches (show when no query) */}
            {!query && (
              <div>
                <div className="flex items-center gap-2 mb-4">
                  <TrendingUp className="size-5 text-sv-red" />
                  <h3 className="text-base font-semibold text-[#F5F5F5]">Trending Searches</h3>
                </div>
                <div className="flex flex-wrap gap-2">
                  {TRENDING_SEARCHES.map((term) => (
                    <button
                      key={term}
                      onClick={() => handleTrendingClick(term)}
                      className="px-4 py-2 rounded-full bg-[#1a1a1a] border border-white/[0.08] text-sm text-[#A0A0A0] hover:text-[#F5F5F5] hover:border-white/[0.2] transition-all duration-200 cursor-pointer"
                    >
                      {term}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Loading state */}
            {isSearching && (
              <div className="mt-4">
                <SearchGridSkeleton count={10} />
              </div>
            )}

            {/* Search results */}
            {!isSearching && results.length > 0 && (
              <div>
                <p className="text-sm text-[#606060] mb-4">
                  {results.length} result{results.length !== 1 ? 's' : ''} for &ldquo;{query}&rdquo;
                </p>
                <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-3">
                  {results.map((item) => {
                    const title = getDisplayTitle(item);
                    const year = getYear(item);
                    const rating = item.vote_average ?? 0;
                    const mediaType = getMediaType(item);
                    const posterUrl = getImageUrl(item.poster_path);

                    return (
                      <button
                        key={`${item.id}-${item.media_type}`}
                        onClick={() => handleResultClick(item)}
                        className="text-left cursor-pointer group"
                      >
                        <div className="aspect-[2/3] rounded-lg overflow-hidden bg-[#1a1a1a] mb-2">
                          <img
                            src={posterUrl}
                            alt={title}
                            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                            loading="lazy"
                          />
                        </div>
                        <p className="text-xs font-medium text-[#F5F5F5] line-clamp-1">
                          {title}
                        </p>
                        <div className="flex items-center gap-1.5 mt-0.5">
                          <span className="text-[10px] text-[#606060] flex items-center gap-0.5">
                            {mediaType === 'tv' ? (
                              <Tv className="size-3" />
                            ) : (
                              <Film className="size-3" />
                            )}
                            {mediaType === 'tv' ? 'TV' : 'Film'}
                          </span>
                          {year && (
                            <>
                              <span className="text-[#606060] text-[10px]">•</span>
                              <span className="text-[10px] text-[#606060]">{year}</span>
                            </>
                          )}
                          {rating > 0 && (
                            <>
                              <span className="text-[#606060] text-[10px]">•</span>
                              <span className="text-[10px] text-sv-gold flex items-center gap-0.5">
                                <Star className="size-3 fill-sv-gold" />
                                {rating.toFixed(1)}
                              </span>
                            </>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* No results */}
            {!isSearching && query && results.length === 0 && (
              <div className="text-center py-16">
                <Search className="size-12 text-[#606060] mx-auto mb-4" />
                <p className="text-[#A0A0A0] text-sm">
                  No results found for &ldquo;{query}&rdquo;
                </p>
                <p className="text-[#606060] text-xs mt-1">
                  Try different keywords or browse trending searches
                </p>
              </div>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
