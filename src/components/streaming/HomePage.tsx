'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { Loader2 } from 'lucide-react';
import HeroSlider from './HeroSlider';
import ContentRow from './ContentRow';
import { RowSkeleton } from './ContentSkeleton';
import type { ContentItem } from '@/types/streaming';
import {
  fetchTrending,
  fetchPopular,
  fetchTopRated,
  fetchNewReleases,
  fetchByGenre,
} from '@/services/api';

interface HomePageProps {
  onNavigate: (page: string, id?: string | number) => void;
  onItemClick: (item: ContentItem) => void;
  onPlay: (item: ContentItem) => void;
  onAddList: (item: ContentItem) => void;
  isInList: (id: string | number) => boolean;
  /** Ref to the scrollable <main> container for infinite scroll detection. */
  scrollRoot?: React.RefObject<HTMLElement | null>;
}

/** Extra genre rows loaded on scroll — only appended once */
const EXTRA_ROWS: { key: string; title: string; genreId: number; type: 'movie' | 'tv' }[] = [
  { key: 'romance', title: 'Romance', genreId: 10749, type: 'movie' },
  { key: 'horror', title: 'Horror', genreId: 27, type: 'movie' },
  { key: 'thriller', title: 'Thriller', genreId: 53, type: 'movie' },
  { key: 'animation', title: 'Animation', genreId: 16, type: 'movie' },
  { key: 'documentary', title: 'Documentary', genreId: 99, type: 'movie' },
  { key: 'crime-tv', title: 'Crime TV', genreId: 80, type: 'tv' },
];

export default function HomePage({ onNavigate, onItemClick, onPlay, onAddList, isInList, scrollRoot }: HomePageProps) {
  // ── Original state: one per category (overwrite, never duplicate) ──
  const [heroItems, setHeroItems] = useState<ContentItem[]>([]);
  const [trending, setTrending] = useState<ContentItem[]>([]);
  const [popularMovies, setPopularMovies] = useState<ContentItem[]>([]);
  const [popularTv, setPopularTv] = useState<ContentItem[]>([]);
  const [topRatedMovies, setTopRatedMovies] = useState<ContentItem[]>([]);
  const [topRatedTv, setTopRatedTv] = useState<ContentItem[]>([]);
  const [newReleases, setNewReleases] = useState<ContentItem[]>([]);
  const [actionMovies, setActionMovies] = useState<ContentItem[]>([]);
  const [comedyMovies, setComedyMovies] = useState<ContentItem[]>([]);
  const [scifiMovies, setScifiMovies] = useState<ContentItem[]>([]);
  const [dramaTv, setDramaTv] = useState<ContentItem[]>([]);

  const [loading, setLoading] = useState(true);
  const abortRef = useRef<AbortController | null>(null);

  // ── Extra rows (loaded on scroll, appended once) ──
  const [moreRows, setMoreRows] = useState<{ key: string; title: string; items: ContentItem[] }[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const moreLoadedRef = useRef(false); // Guard: load extra rows only once

  const loadData = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const [
        trendingData,
        popularMoviesData,
        popularTvData,
        topRatedMoviesData,
        topRatedTvData,
        newReleasesData,
        actionData,
        comedyData,
        scifiData,
        dramaTvData,
      ] = await Promise.all([
        fetchTrending(1, 'all', signal).catch(() => []),
        fetchPopular(1, 'movie', signal).catch(() => []),
        fetchPopular(1, 'tv', signal).catch(() => []),
        fetchTopRated(1, 'movie', signal).catch(() => []),
        fetchTopRated(1, 'tv', signal).catch(() => []),
        fetchNewReleases(signal).catch(() => []),
        fetchByGenre(28, 1, 'movie', signal).catch(() => []), // Action
        fetchByGenre(35, 1, 'movie', signal).catch(() => []), // Comedy
        fetchByGenre(878, 1, 'movie', signal).catch(() => []), // Sci-Fi
        fetchByGenre(18, 1, 'tv', signal).catch(() => []), // Drama TV
      ]);

      // Skip state updates if aborted (component unmounted or new load started)
      if (signal?.aborted) return;

      // Helper: ensure media_type is set — TV-specific endpoints don't return it
      const tagType = (items: ContentItem[], type: 'movie' | 'tv') =>
        items.map((i) => ({ ...i, media_type: i.media_type || type }));

      // Filter hero items to only those with backdrops
      const withBackdrop = trendingData.filter((i) => i.backdrop_path);
      setHeroItems(withBackdrop.slice(0, 8));

      setTrending(trendingData.slice(0, 20));
      setPopularMovies(tagType(popularMoviesData, 'movie').slice(0, 20));
      setPopularTv(tagType(popularTvData, 'tv').slice(0, 20));
      setTopRatedMovies(tagType(topRatedMoviesData, 'movie').slice(0, 20));
      setTopRatedTv(tagType(topRatedTvData, 'tv').slice(0, 20));
      setNewReleases(tagType(newReleasesData, 'movie').slice(0, 20));
      setActionMovies(tagType(actionData, 'movie').slice(0, 20));
      setComedyMovies(tagType(comedyData, 'movie').slice(0, 20));
      setScifiMovies(tagType(scifiData, 'movie').slice(0, 20));
      setDramaTv(tagType(dramaTvData, 'tv').slice(0, 20));
    } catch {
      // Individual fetches are already caught via .catch(() => [])
      // This only fires on truly unexpected errors (e.g., signal aborted mid-destructure)
    } finally {
      if (!signal?.aborted) {
        setLoading(false);
      }
    }
  }, []);

  // Initial load + abort on unmount
  useEffect(() => {
    const controller = new AbortController();
    abortRef.current = controller;
    loadData(controller.signal);

    return () => {
      controller.abort();
      loadMoreAbortRef.current?.abort();
    };
  }, [loadData]);

  // Reload data when coming back online (debounced)
  useEffect(() => {
    const handleOnline = () => {
      // Small delay to let network stabilize before hitting APIs
      const timer = setTimeout(() => {
        abortRef.current?.abort();
        const controller = new AbortController();
        abortRef.current = controller;
        loadData(controller.signal);
      }, 1000);
      return () => clearTimeout(timer);
    };

    window.addEventListener('online', handleOnline);
    return () => window.removeEventListener('online', handleOnline);
  }, [loadData]);

  // ── Infinite scroll: load extra genre rows when user scrolls near bottom ──
  useEffect(() => {
    const rootEl = scrollRoot?.current;
    if (!rootEl || moreLoadedRef.current) return;

    const THRESHOLD_PX = 500;
    let ticking = false;

    const onScroll = () => {
      if (ticking || moreLoadedRef.current) return;
      ticking = true;

      requestAnimationFrame(() => {
        ticking = false;

        const { scrollTop, scrollHeight, clientHeight } = rootEl;
        const distanceFromBottom = scrollHeight - scrollTop - clientHeight;

        if (distanceFromBottom <= THRESHOLD_PX && !moreLoadedRef.current) {
          moreLoadedRef.current = true; // Set immediately — prevents double-fire
          rootEl.removeEventListener('scroll', onScroll);
          loadMoreRows();
        }
      });
    };

    rootEl.addEventListener('scroll', onScroll, { passive: true });
    return () => rootEl.removeEventListener('scroll', onScroll);
  }, [scrollRoot]);

  // ── Infinite scroll: load extra genre rows when user scrolls near bottom ──
  const loadMoreAbortRef = useRef<AbortController | null>(null);

  const loadMoreRows = useCallback(() => {
    // Cancel any in-flight extra-rows fetch (component may have remounted)
    loadMoreAbortRef.current?.abort();
    const controller = new AbortController();
    loadMoreAbortRef.current = controller;

    setLoadingMore(true);
    Promise.all(
      EXTRA_ROWS.map(async (row) => {
        try {
          const items = await fetchByGenre(row.genreId, 1, row.type, controller.signal);
          return { key: row.key, title: row.title, items };
        } catch {
          return { key: row.key, title: row.title, items: [] };
        }
      }),
    ).then((results) => {
      if (controller.signal.aborted) return;
      const nonEmpty = results
        .filter((r) => r.items.length > 0)
        .map((r) => ({
          key: r.key,
          title: r.title,
          items: r.items.map((i) => ({ ...i, media_type: i.media_type || r.items[0]?.media_type || r.items[0]?.title ? 'movie' : 'tv' })).slice(0, 20),
        }));

      setMoreRows(nonEmpty);
    }).finally(() => {
      if (!controller.signal.aborted) setLoadingMore(false);
    });
  }, []);

  const handleItemClick = useCallback(
    (item: ContentItem) => {
      onItemClick(item);
    },
    [onItemClick]
  );

  const handleHeroPlay = useCallback(
    (item: ContentItem) => {
      onPlay(item);
    },
    [onPlay]
  );

  const handleHeroInfo = useCallback(
    (item: ContentItem) => {
      onItemClick(item);
    },
    [onItemClick]
  );

  return (
    <div className="pb-20">
      {/* Hero Section */}
      <HeroSlider
        items={heroItems}
        isLoading={loading}
        onPlay={handleHeroPlay}
        onInfo={handleHeroInfo}
        onAddList={onAddList}
        isInList={isInList}
      />

      {/* Content Rows */}
      {loading ? (
        <div className="mt-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <RowSkeleton key={i} />
          ))}
        </div>
      ) : (
        <div className="mt-2 space-y-0">
          {trending.length > 0 && (
            <ContentRow
              title="Trending Now"
              items={trending}
              onItemClick={handleItemClick}
              index={0}
            />
          )}
          {newReleases.length > 0 && (
            <ContentRow
              title="New Releases"
              items={newReleases}
              onItemClick={handleItemClick}
              index={1}
            />
          )}
          {popularMovies.length > 0 && (
            <ContentRow
              title="Popular Movies"
              items={popularMovies}
              onItemClick={handleItemClick}
              index={2}
            />
          )}
          {popularTv.length > 0 && (
            <ContentRow
              title="Popular Series"
              items={popularTv}
              onItemClick={handleItemClick}
              index={3}
            />
          )}
          {topRatedMovies.length > 0 && (
            <ContentRow
              title="Top Rated Movies"
              items={topRatedMovies}
              onItemClick={handleItemClick}
              index={4}
            />
          )}
          {topRatedTv.length > 0 && (
            <ContentRow
              title="Top Rated Series"
              items={topRatedTv}
              onItemClick={handleItemClick}
              index={5}
            />
          )}
          {actionMovies.length > 0 && (
            <ContentRow
              title="Action & Adventure"
              items={actionMovies}
              onItemClick={handleItemClick}
              index={6}
            />
          )}
          {comedyMovies.length > 0 && (
            <ContentRow
              title="Comedy"
              items={comedyMovies}
              onItemClick={handleItemClick}
              index={7}
            />
          )}
          {scifiMovies.length > 0 && (
            <ContentRow
              title="Sci-Fi & Fantasy"
              items={scifiMovies}
              onItemClick={handleItemClick}
              index={8}
            />
          )}
          {dramaTv.length > 0 && (
            <ContentRow
              title="Drama Series"
              items={dramaTv}
              onItemClick={handleItemClick}
              index={9}
            />
          )}

          {/* Extra rows loaded on scroll */}
          {moreRows.map((row) => (
            row.items.length > 0 && (
              <ContentRow
                key={row.key}
                title={row.title}
                items={row.items}
                onItemClick={handleItemClick}
              />
            )
          ))}

          {/* Loading more indicator */}
          {loadingMore && (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-[#A0A0A0]">
              <Loader2 className="size-4 animate-spin" />
              <span>Loading more...</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
