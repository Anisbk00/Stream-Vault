'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Search, X, TrendingUp, Star, Film, Tv, SlidersHorizontal, ChevronDown } from 'lucide-react';
import { searchContent, getImageUrl, fetchGenres, type SearchFilters } from '@/services/api';
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
  restoreFilters?: SearchFilters;
  /** Called once after restore has been consumed so the parent can clear it */
  onRestoreConsumed?: () => void;
}

const TRENDING_SEARCHES = [
  'Action', 'Comedy', 'Drama', 'Sci-Fi', 'Thriller',
  'Horror', 'Romance', 'Animation', 'Documentary',
];

const TYPE_OPTIONS: { value: 'all' | 'movie' | 'tv'; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'movie', label: 'Movies' },
  { value: 'tv', label: 'TV' },
];

const SORT_OPTIONS: { value: 'popularity' | 'rating' | 'newest' | 'oldest'; label: string }[] = [
  { value: 'popularity', label: 'Most Popular' },
  { value: 'rating', label: 'Highest Rated' },
  { value: 'newest', label: 'Newest' },
  { value: 'oldest', label: 'Oldest' },
];

const RATING_OPTIONS = [
  { value: '', label: 'Any Rating' },
  { value: '5', label: '5+ ★' },
  { value: '6', label: '6+ ★' },
  { value: '7', label: '7+ ★' },
  { value: '8', label: '8+ ★' },
];

// Build year options: current year down to 1960
const CURRENT_YEAR = new Date().getFullYear();
const YEAR_OPTIONS = [
  { value: '', label: 'Any Year' },
  ...Array.from({ length: CURRENT_YEAR - 1960 + 1 }, (_, i) => {
    const y = CURRENT_YEAR - i;
    return { value: String(y), label: String(y) };
  }),
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

export default function SearchOverlay({ isOpen, onClose, onNavigate, onItemClick, restoreQuery, restoreResults, restoreFilters, onRestoreConsumed }: SearchOverlayProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ContentItem[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [filters, setFilters] = useState<SearchFilters>({ type: 'all', sort: 'popularity' });
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false);
  const [genres, setGenres] = useState<{ id: number; name: string }[]>([]);

  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  const focusTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const abortRef = useRef<AbortController | null>(null);
  const restoreConsumedRef = useRef(false);
  // When restoring, skip the debounced search so restored results don't get
  // overwritten by a fresh fetch (avoids loading-spinner flash + wasted API call)
  const isRestoringRef = useRef(false);
  const genresFetchedRef = useRef(false);

  // Count active advanced filters for the badge
  const activeFilterCount = useMemo(() => {
    let n = 0;
    if (filters.year) n++;
    if (filters.genre) n++;
    if (filters.sort && filters.sort !== 'popularity') n++;
    if (filters.min_rating) n++;
    return n;
  }, [filters]);

  // Fetch genres once (for the genre dropdown)
  useEffect(() => {
    if (genresFetchedRef.current) return;
    genresFetchedRef.current = true;
    fetchGenres('movie').then(setGenres).catch(() => {});
  }, []);

  // Focus input + restore state when opening
  useEffect(() => {
    if (isOpen) {
      // Restore saved search state if coming back from detail page
      if (restoreQuery && restoreResults && !restoreConsumedRef.current) {
        setQuery(restoreQuery);
        setResults(restoreResults);
        setFilters(restoreFilters || { type: 'all', sort: 'popularity' });
        setIsSearching(false);
        isRestoringRef.current = true;
        restoreConsumedRef.current = true;
        onRestoreConsumed?.();
      } else if (!restoreConsumedRef.current) {
        // Fresh open — clear state.
        // Guarded by !restoreConsumedRef so this does NOT fire when
        // onRestoreConsumed clears the store (which changes restoreQuery to
        // undefined and re-triggers this effect) — in that case we've already
        // restored and must keep the restored state.
        setQuery('');
        setResults([]);
        setFilters({ type: 'all', sort: 'popularity' });
        setIsSearching(false);
        setShowAdvancedFilters(false);
      }
      focusTimerRef.current = setTimeout(() => inputRef.current?.focus(), 100);
    } else {
      // Closing — reset the consumed flag so the next open can restore again
      restoreConsumedRef.current = false;
      if (focusTimerRef.current) clearTimeout(focusTimerRef.current);
      if (abortRef.current) abortRef.current.abort();
      if (debounceRef.current) clearTimeout(debounceRef.current);
    }
    return () => {
      if (focusTimerRef.current) clearTimeout(focusTimerRef.current);
    };
  }, [isOpen, restoreQuery, restoreResults, restoreFilters, onRestoreConsumed]);

  // Debounced search with AbortController
  useEffect(() => {
    if (isRestoringRef.current) {
      // Skip the search when restoring — results are already set from restoreResults
      isRestoringRef.current = false;
      return;
    }
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
        const data = await searchContent(query, 1, controller.signal, filters);
        if (!controller.signal.aborted) setResults(data);
      } catch {
        if (!controller.signal.aborted) setResults([]);
      } finally {
        if (!controller.signal.aborted) setIsSearching(false);
      }
    }, 400);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (abortRef.current) abortRef.current.abort();
    };
  }, [query, filters]);

  const handleTrendingClick = useCallback((term: string) => {
    setQuery(term);
  }, []);

  const handleTypeChange = useCallback((type: 'all' | 'movie' | 'tv') => {
    setFilters((f) => ({ ...f, type }));
  }, []);

  const handleFilterChange = useCallback((key: keyof SearchFilters, value: string) => {
    setFilters((f) => ({ ...f, [key]: value || undefined }));
  }, []);

  const handleClearFilters = useCallback(() => {
    setFilters({ type: filters.type || 'all', sort: 'popularity' });
  }, [filters.type]);

  const handleResultClick = (item: ContentItem) => {
    // Save search state to store BEFORE closing so back-navigation can restore it
    if (query.trim() && results.length > 0) {
      useUIStore.getState().saveSearchState(query, results, filters);
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
            <div className="px-4 pt-4 pb-3 max-w-4xl mx-auto">
              <div className="flex items-center gap-3">
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
                  onClick={() => setShowAdvancedFilters((v) => !v)}
                  className={`relative w-9 h-9 flex items-center justify-center rounded-full transition-colors cursor-pointer ${showAdvancedFilters || activeFilterCount > 0 ? 'bg-sv-red/20 text-sv-red' : 'hover:bg-white/[0.1] text-[#A0A0A0]'}`}
                  aria-label="Filters"
                >
                  <SlidersHorizontal className="size-5" />
                  {activeFilterCount > 0 && (
                    <span className="absolute -top-0.5 -right-0.5 w-4 h-4 rounded-full bg-sv-red text-white text-[9px] font-bold flex items-center justify-center">
                      {activeFilterCount}
                    </span>
                  )}
                </button>
                <button
                  onClick={onClose}
                  className="w-9 h-9 flex items-center justify-center rounded-full hover:bg-white/[0.1] transition-colors cursor-pointer"
                  aria-label="Close search"
                >
                  <X className="size-5 text-[#F5F5F5]" />
                </button>
              </div>

              {/* Type chips — always visible */}
              <div className="flex items-center gap-2 mt-3">
                {TYPE_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => handleTypeChange(opt.value)}
                    className={`px-3.5 py-1.5 rounded-full text-xs font-semibold transition-all duration-200 cursor-pointer ${
                      (filters.type || 'all') === opt.value
                        ? 'bg-sv-red text-white'
                        : 'bg-white/[0.06] text-[#A0A0A0] hover:text-[#F5F5F5] hover:bg-white/[0.1]'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>

              {/* Advanced filters — collapsible */}
              <AnimatePresence>
                {showAdvancedFilters && (
                  <motion.div
                    initial={{ opacity: 0, height: 0, marginTop: 0 }}
                    animate={{ opacity: 1, height: 'auto', marginTop: 12 }}
                    exit={{ opacity: 0, height: 0, marginTop: 0 }}
                    transition={{ duration: 0.2 }}
                    className="overflow-hidden"
                  >
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                      {/* Year */}
                      <FilterSelect
                        label="Year"
                        value={filters.year || ''}
                        onChange={(v) => handleFilterChange('year', v)}
                        options={YEAR_OPTIONS}
                      />
                      {/* Genre */}
                      <FilterSelect
                        label="Genre"
                        value={filters.genre || ''}
                        onChange={(v) => handleFilterChange('genre', v)}
                        options={[
                          { value: '', label: 'Any Genre' },
                          ...genres.map((g) => ({ value: String(g.id), label: g.name })),
                        ]}
                      />
                      {/* Sort */}
                      <FilterSelect
                        label="Sort"
                        value={filters.sort || 'popularity'}
                        onChange={(v) => handleFilterChange('sort', v)}
                        options={SORT_OPTIONS}
                      />
                      {/* Min Rating */}
                      <FilterSelect
                        label="Rating"
                        value={filters.min_rating || ''}
                        onChange={(v) => handleFilterChange('min_rating', v)}
                        options={RATING_OPTIONS}
                      />
                    </div>
                    {activeFilterCount > 0 && (
                      <button
                        onClick={handleClearFilters}
                        className="mt-2 text-xs text-[#808080] hover:text-sv-red transition-colors cursor-pointer"
                      >
                        Clear advanced filters
                      </button>
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
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
                  Try different keywords or adjust your filters
                </p>
              </div>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ── Compact filter select dropdown ──────────────────────────
function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div className="relative">
      <label className="block text-[10px] font-semibold text-[#606060] uppercase tracking-wide mb-1">
        {label}
      </label>
      <div className="relative">
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full appearance-none bg-white/[0.06] border border-white/[0.12] rounded-lg px-3 py-2 pr-8 text-xs text-[#F5F5F5] outline-none focus:border-sv-red/50 cursor-pointer hover:bg-white/[0.08] transition-colors"
        >
          {options.map((opt) => (
            <option key={opt.value} value={opt.value} className="bg-[#1a1a1a] text-[#F5F5F5]">
              {opt.label}
            </option>
          ))}
        </select>
        <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 size-3.5 text-[#606060] pointer-events-none" />
      </div>
    </div>
  );
}
