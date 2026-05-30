'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import type { SubtitleTrack, SubtitleCue } from '@/types/subtitles';
import { parseSubtitles } from '@/lib/subtitles/parser';

interface UseExternalSubtitlesOptions {
  /** TMDB content ID — used when IMDB ID is not available */
  tmdbId?: string | number;
  /** IMDB ID (e.g. tt1234567) — used directly when available, skips TMDB lookup */
  imdbId?: string | null;
  /** Content type */
  mediaType?: 'movie' | 'tv';
  /** Season number (TV only) */
  season?: number;
  /** Episode number (TV only) */
  episode?: number;
  /** Current video playback time in seconds — updated from PLAYER_EVENT */
  currentTime: number;
  /** Whether subtitles are currently enabled */
  enabled: boolean;
}

interface UseExternalSubtitlesReturn {
  /** Currently visible subtitle cue (null when no subtitle should show) */
  currentCue: SubtitleCue | null;
  /** Available subtitle tracks (fetched from API) */
  tracks: SubtitleTrack[];
  /** Currently selected track */
  selectedTrack: SubtitleTrack | null;
  /** Select a track (triggers download + parse) */
  selectTrack: (track: SubtitleTrack) => void;
  /** Clear selected track */
  clearTrack: () => void;
  /** Subtitle time offset in seconds (positive = later, negative = earlier) */
  offset: number;
  /** Adjust subtitle offset */
  adjustOffset: (delta: number) => void;
  /** Whether tracks are being fetched */
  loading: boolean;
  /** Error message (e.g., API key not configured) */
  error: string | null;
}

export function useExternalSubtitles({
  tmdbId,
  imdbId,
  mediaType,
  season,
  episode,
  currentTime,
  enabled,
}: UseExternalSubtitlesOptions): UseExternalSubtitlesReturn {
  const [tracks, setTracks] = useState<SubtitleTrack[]>([]);
  const [selectedTrack, setSelectedTrack] = useState<SubtitleTrack | null>(null);
  const [cues, setCues] = useState<SubtitleCue[]>([]);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // ── Fetch available tracks when CC is enabled ──
  useEffect(() => {
    if (!enabled) return;
    // Need either IMDB ID or TMDB ID to search subtitles
    const identifier = imdbId || tmdbId;
    if (!identifier) return;

    const controller = new AbortController();
    abortRef.current = controller;

    const fetchTracks = async () => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({
          action: 'search',
          type: mediaType || 'movie',
        });
        // Only send tmdbId/imdbId if they have actual values — empty strings
        // are falsy in JS but URLSearchParams.get() returns "" not null,
        // breaking all falsy checks in the API route's fallback logic
        if (tmdbId) params.set('tmdbId', String(tmdbId));
        if (imdbId) params.set('imdbId', imdbId);
        if (season !== undefined) params.set('season', String(season));
        if (episode !== undefined) params.set('episode', String(episode));

        const response = await fetch(`/api/stream/subtitles?${params.toString()}`, {
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error('Failed to fetch subtitles');
        }

        const data = await response.json();
        if (data.error) {
          setError(data.error);
        }
        setTracks(data.tracks || []);
      } catch (err) {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : 'Failed to search subtitles');
        setTracks([]);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };

    fetchTracks();
    return () => { controller.abort(); };
  }, [enabled, tmdbId, imdbId, mediaType, season, episode]);

  // ── Download and parse selected track ──
  useEffect(() => {
    if (!selectedTrack) {
      setCues([]);
      return;
    }

    const controller = new AbortController();

    const downloadAndParse = async () => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({
          action: 'download',
          fileId: selectedTrack.id,
        });

        const response = await fetch(`/api/stream/subtitles?${params.toString()}`, {
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error('Failed to download subtitle file');
        }

        const text = await response.text();
        const parsed = parseSubtitles(text);
        setCues(parsed);

        if (parsed.length === 0) {
          setError('No subtitle cues found in file');
        }
      } catch (err) {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : 'Failed to download subtitle');
        setCues([]);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };

    downloadAndParse();
    return () => { controller.abort(); };
  }, [selectedTrack]);

  const selectTrack = useCallback((track: SubtitleTrack) => {
    setSelectedTrack(track);
    setOffset(0);
    setCues([]);
    setError(null);
  }, []);

  const clearTrack = useCallback(() => {
    setSelectedTrack(null);
    setCues([]);
    setOffset(0);
    setError(null);
  }, []);

  const adjustOffset = useCallback((delta: number) => {
    setOffset((prev) => Math.max(-10, Math.min(10, prev + delta)));
  }, []);

  // ── Find current cue based on playback time + offset ──
  const currentCue = useMemo(() => {
    if (!enabled || cues.length === 0) return null;
    const adjustedTime = currentTime + offset;
    return cues.find((cue) => adjustedTime >= cue.start && adjustedTime <= cue.end) || null;
  }, [currentTime, offset, cues, enabled]);

  // Cleanup on unmount
  useEffect(() => {
    return () => { abortRef.current?.abort(); };
  }, []);

  return {
    currentCue,
    tracks,
    selectedTrack,
    selectTrack,
    clearTrack,
    offset,
    adjustOffset,
    loading,
    error,
  };
}
