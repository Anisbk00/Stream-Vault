'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { motion } from 'framer-motion';
import { Film, Tv, LayoutGrid, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import ContentCard from './ContentCard';
import GenreChips from './GenreChips';
import { GridSkeleton } from './ContentSkeleton';
import type { ContentItem } from '@/types/streaming';
import { fetchGenres, fetchByGenre, fetchPopular } from '@/services/api';

interface BrowsePageProps {
  onNavigate: (page: string, id?: string | number) => void;
  onItemClick: (item: ContentItem) => void;
  /** Ref to the scrollable container (e.g. <main>) so IntersectionObserver
   *  tracks scroll inside it instead of the document viewport. */
  scrollRoot?: React.RefObject<HTMLElement | null>;
}

type ContentType = 'movie' | 'tv' | 'all';

const TYPE_OPTIONS: { value: ContentType; label: string; icon: React.ReactNode }[] = [
  { value: 'all', label: 'All', icon: <LayoutGrid className="size-4" /> },
  { value: 'movie', label: 'Movies', icon: <Film className="size-4" /> },
  { value: 'tv', label: 'Series', icon: <Tv className="size-4" /> },
];

const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { staggerChildren: 0.04, delayChildren: 0.05 },
  },
};

const itemVariants = {
  hidden: { opacity: 0, y: 16, scale: 0.96 },
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
};

export default function BrowsePage({ onNavigate, onItemClick, scrollRoot }: BrowsePageProps) {
  const [genres, setGenres] = useState<{ id: number; name: string }[]>([]);
  const [selectedGenre, setSelectedGenre] = useState<number | null>(null);
  const [contentType, setContentType] = useState<ContentType>('all');
  const [content, setContent] = useState<ContentItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [genresLoaded, setGenresLoaded] = useState(false);

  const isFetchingRef = useRef(false);

  // Fetch genres on mount
  useEffect(() => {
    const controller = new AbortController();

    async function loadGenres() {
      try {
        const [movieGenres, tvGenres] = await Promise.allSettled([
          fetchGenres('movie', controller.signal),
          fetchGenres('tv', controller.signal),
        ]);
        // Deduplicate genres by id, keeping movie name
        const genreMap = new Map<number, string>();
        if (movieGenres.status === 'fulfilled') {
          movieGenres.value.forEach((g) => genreMap.set(g.id, g.name));
        }
        if (tvGenres.status === 'fulfilled') {
          tvGenres.value.forEach((g) => {
            if (!genreMap.has(g.id)) genreMap.set(g.id, g.name);
          });
        }
        const deduped = Array.from(genreMap.entries()).map(([id, name]) => ({ id, name }));
        deduped.sort((a, b) => a.name.localeCompare(b.name));
        if (!controller.signal.aborted) setGenres(deduped);
      } catch {
        // Silently fail — genre chips just won't show
      } finally {
        if (!controller.signal.aborted) setGenresLoaded(true);
      }
    }
    loadGenres();
    return () => controller.abort();
  }, []);

  // Fetch content when genre or type changes
  const fetchContent = useCallback(
    async (pageNum: number, append: boolean = false, signal?: AbortSignal) => {
      // Race guard — prevent duplicate concurrent fetches
      if (isFetchingRef.current) return;
      isFetchingRef.current = true;

      const isLoadMore = append;
      if (isLoadMore) {
        setLoadingMore(true);
      } else {
        setLoading(true);
      }

      try {
        let results: ContentItem[] = [];

        if (selectedGenre !== null) {
          if (contentType === 'all') {
            // Fetch both movies AND TV for the selected genre — some genres
            // are TV-dominant (Reality, Talk, News, etc.) and return empty
            // if only movies are queried.
            const [moviesResult, tvResult] = await Promise.allSettled([
              fetchByGenre(selectedGenre, pageNum, 'movie', signal),
              fetchByGenre(selectedGenre, pageNum, 'tv', signal),
            ]);
            const movies = moviesResult.status === 'fulfilled' ? moviesResult.value : [];
            const tvShows = tvResult.status === 'fulfilled' ? tvResult.value : [];
            results = [
              ...movies.map((i) => ({ ...i, media_type: i.media_type || 'movie' })),
              ...tvShows.map((i) => ({ ...i, media_type: i.media_type || 'tv' })),
            ].sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0));
          } else {
            const raw = await fetchByGenre(selectedGenre, pageNum, contentType, signal);
            results = raw.map((i) => ({ ...i, media_type: i.media_type || contentType }));
          }
        } else if (contentType === 'all') {
          // Use allSettled — one TMDB failure returns available data
          const [moviesResult, tvResult] = await Promise.allSettled([
            fetchPopular(pageNum, 'movie', signal),
            fetchPopular(pageNum, 'tv', signal),
          ]);
          const movies = moviesResult.status === 'fulfilled' ? moviesResult.value : [];
          const tvShows = tvResult.status === 'fulfilled' ? tvResult.value : [];
          const taggedMovies = movies.map((i) => ({ ...i, media_type: i.media_type || 'movie' }));
          const taggedTv = tvShows.map((i) => ({ ...i, media_type: i.media_type || 'tv' }));
          results = [...taggedMovies, ...taggedTv].sort(
            (a, b) => (b.popularity ?? 0) - (a.popularity ?? 0)
          );
        } else {
          const raw = await fetchPopular(pageNum, contentType, signal);
          results = raw.map((i) => ({ ...i, media_type: i.media_type || contentType }));
        }

        if (!signal?.aborted) {
          if (append) {
            setContent((prev) => {
              const existingIds = new Set(prev.map((i) => String(i.id)));
              const newItems = results.filter((i) => !existingIds.has(String(i.id)));
              return [...prev, ...newItems];
            });
          } else {
            setContent(results);
          }
          // TMDB returns 20 items per page. Use 20 (not 15) to correctly detect
          // when the last page has been reached. 15 would prematurely stop
          // pagination when a page returns between 15-19 items.
          setHasMore(results.length >= 20);
        }
      } catch {
        if (!signal?.aborted && !append) {
          setContent([]);
        }
      } finally {
        if (!signal?.aborted) {
          setLoading(false);
          setLoadingMore(false);
        }
        isFetchingRef.current = false;
      }
    },
    [selectedGenre, contentType]
  );

  // Reset and refetch when genre/type changes
  useEffect(() => {
    const controller = new AbortController();
    setPage(1);
    setHasMore(true);
    setContent([]);
    fetchContent(1, false, controller.signal);
    return () => controller.abort();
  }, [fetchContent, selectedGenre, contentType]);

  // Stable callback that reads current page from a ref — avoids
  // re-registering the scroll listener every render.
  const pageRef = useRef(page);
  pageRef.current = page;

  const handleLoadMore = useCallback(() => {
    if (isFetchingRef.current) return; // Race guard
    const nextPage = pageRef.current + 1;
    setPage(nextPage);
    const controller = new AbortController();
    fetchContent(nextPage, true, controller.signal);
  }, [fetchContent]); // Stable — no page/loadingMore dependency

  // Infinite scroll — scroll event listener on the app's <main> scroll container.
  // Using scroll events instead of IntersectionObserver because:
  //  1. The scroll container is <main overflow-y-auto>, not the document viewport
  //  2. IntersectionObserver with nested scroll roots has browser-specific quirks
  //  3. Scroll event + rAF throttle is more reliable for this specific layout
  // Note: handleLoadMore is stable (ref-based page reading), so this listener
  // is registered ONCE per hasMore/scrollRoot change — not every render.
  useEffect(() => {
    const rootEl = scrollRoot?.current;
    if (!rootEl || !hasMore) return;

    const THRESHOLD_PX = 400; // Trigger load when within 400px of bottom
    let ticking = false;

    const onScroll = () => {
      if (ticking) return;
      ticking = true;

      requestAnimationFrame(() => {
        ticking = false;
        if (isFetchingRef.current) return;

        const { scrollTop, scrollHeight, clientHeight } = rootEl;
        const distanceFromBottom = scrollHeight - scrollTop - clientHeight;

        if (distanceFromBottom <= THRESHOLD_PX) {
          handleLoadMore();
        }
      });
    };

    rootEl.addEventListener('scroll', onScroll, { passive: true });
    return () => rootEl.removeEventListener('scroll', onScroll);
  }, [hasMore, handleLoadMore, scrollRoot]);

  const handleGenreSelect = useCallback((id: number) => {
    setSelectedGenre((prev) => (prev === id ? null : id));
  }, []);

  return (
    <section className="min-h-[calc(100dvh-1rem)] bg-[#080808]">
      {/* Page header */}
      <div className="px-4 mb-6">
        <motion.div
          initial={{ opacity: 0, y: -12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
        >
          <div className="flex items-center gap-3 mb-4">
            <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-white/[0.08]">
              <LayoutGrid className="size-5 text-[#F5F5F5]" />
            </div>
            <h1 className="text-2xl font-bold text-[#F5F5F5]">Browse</h1>
          </div>

          {/* Type toggle */}
          <div className="flex items-center gap-2">
            {TYPE_OPTIONS.map((option) => {
              const isActive = contentType === option.value;
              return (
                <Button
                  key={option.value}
                  onClick={() => setContentType(option.value)}
                  variant={isActive ? 'default' : 'outline'}
                  className={`
                    h-9 px-4 rounded-lg text-sm font-medium transition-all duration-200
                    ${
                      isActive
                        ? 'bg-sv-red hover:bg-sv-red-hover text-white border-sv-red'
                        : 'bg-white/[0.05] hover:bg-white/10 border-white/[0.1] text-[#A0A0A0] hover:text-[#F5F5F5]'
                    }
                  `}
                >
                  <span className="mr-1.5">{option.icon}</span>
                  {option.label}
                </Button>
              );
            })}
          </div>
        </motion.div>
      </div>

      {/* Genre chips */}
      {genresLoaded && genres.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: 0.1 }}
          className="mb-6"
        >
          <GenreChips
            genres={genres}
            selected={selectedGenre ?? undefined}
            onSelect={handleGenreSelect}
          />
        </motion.div>
      )}

      {/* Content grid */}
      <div className="px-4">
        {loading ? (
          <GridSkeleton count={15} />
        ) : content.length === 0 ? (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="flex flex-col items-center justify-center text-center py-20"
          >
            <div className="flex items-center justify-center w-20 h-20 rounded-full bg-white/[0.05] mb-4">
              <Film className="size-8 text-[#606060]" />
            </div>
            <h3 className="text-lg font-semibold text-[#F5F5F5] mb-1">No results found</h3>
            <p className="text-sm text-[#606060]">Try adjusting your filters or check back later.</p>
          </motion.div>
        ) : (
          <>
            <motion.div
              variants={containerVariants}
              initial="hidden"
              animate="visible"
              key={`${selectedGenre}-${contentType}`}
              className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3"
            >
              {content.map((item) => (
                <motion.div key={String(item.id)} variants={itemVariants}>
                  <ContentCard
                    item={item}
                    onClick={() => onItemClick(item)}
                  />
                </motion.div>
              ))}
            </motion.div>

            {/* Loading indicator */}
            {loadingMore && (
              <div className="flex justify-center mt-8 mb-4">
                <div className="flex items-center gap-2 text-sm text-[#A0A0A0]">
                  <Loader2 className="size-4 animate-spin" />
                  <span>Loading more...</span>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
