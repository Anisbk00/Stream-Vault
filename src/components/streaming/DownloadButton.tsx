'use client';

import { useCallback, useRef } from 'react';
import { Download, Check, Loader2, Trash2, RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useDownloadStore } from '@/store';
import {
  orchestrateDownload,
  cancelDownload,
  hasActiveController,
} from '@/lib/download-service';
import type { DownloadTask } from '@/lib/hls-downloader';

interface DownloadButtonProps {
  contentId: string | number;
  mediaType: 'movie' | 'tv';
  title: string;
  posterUrl?: string;
  year?: string;
  season?: number;
  episode?: number;
  compact?: boolean;
}

/**
 * DownloadButton — thin UI wrapper.
 * All download orchestration is delegated to download-service.ts,
 * which survives component unmounts and page navigation.
 */
export default function DownloadButton({
  contentId,
  mediaType,
  title,
  posterUrl,
  year,
  season,
  episode,
  compact = false,
}: DownloadButtonProps) {
  const removeTask = useDownloadStore((s) => s.removeTask);
  const existingTask = useDownloadStore((s) =>
    s.tasks.find(
      (t) =>
        String(t.contentId) === String(contentId) &&
        t.season === season &&
        t.episode === episode,
    ),
  );

  const isDownloading =
    existingTask?.status === 'downloading' || existingTask?.status === 'pending';
  const isCompleted = existingTask?.status === 'completed';
  const isError = existingTask?.status === 'error';
  const progress = existingTask?.progress ?? 0;

  // Prevent rapid double-clicks before the store updates
  const isStartingRef = useRef(false);

  const handleStart = useCallback(() => {
    if (isStartingRef.current) return;
    isStartingRef.current = true;
    // Reset after a short delay (store will have 'pending' task by then)
    setTimeout(() => {
      isStartingRef.current = false;
    }, 500);

    orchestrateDownload({ contentId, mediaType, title, posterUrl, year, season, episode });
  }, [contentId, mediaType, title, posterUrl, year, season, episode]);

  const handleDelete = useCallback(() => {
    if (existingTask) {
      cancelDownload(existingTask.id);
      removeTask(existingTask.id);
    }
  }, [existingTask, removeTask]);

  // ── Compact mode (episode-level download icon) ──────────
  if (compact) {
    if (isCompleted) {
      return (
        <button
          onClick={(e) => {
            e.stopPropagation();
          }}
          className="flex items-center justify-center w-8 h-8 rounded-full bg-sv-blue/20 text-sv-blue hover:bg-sv-blue/30 transition-colors cursor-pointer"
          aria-label="Downloaded"
        >
          <Check className="size-4" />
        </button>
      );
    }

    if (isDownloading) {
      return (
        <button
          disabled
          className="flex items-center justify-center w-8 h-8 rounded-full bg-sv-red/20 text-sv-red cursor-default"
          aria-label={`Downloading ${Math.round(progress)}%`}
        >
          <Loader2 className="size-4 animate-spin" />
        </button>
      );
    }

    if (isError) {
      return (
        <button
          onClick={(e) => {
            e.stopPropagation();
            handleStart();
          }}
          className="flex items-center justify-center w-8 h-8 rounded-full bg-amber-500/20 text-amber-400 hover:bg-amber-500/30 transition-colors cursor-pointer"
          aria-label="Download failed — tap to retry"
        >
          <RotateCw className="size-4" />
        </button>
      );
    }

    return (
      <button
        onClick={(e) => {
          e.stopPropagation();
          handleStart();
        }}
        className="flex items-center justify-center w-8 h-8 rounded-full hover:bg-white/[0.15] text-[#A0A0A0] hover:text-[#F5F5F5] transition-colors cursor-pointer"
        aria-label="Download episode"
      >
        <Download className="size-4" />
      </button>
    );
  }

  // ── Full mode (detail page download button) ────────────

  if (isCompleted) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            className="h-11 px-5 rounded-lg bg-sv-blue hover:bg-sv-blue/80 text-white font-semibold cursor-pointer"
          >
            <Check className="size-5" />
            Downloaded
            {existingTask?.quality && (
              <Badge
                variant="secondary"
                className="ml-2 bg-white/20 text-white text-[10px] font-bold px-1.5 py-0 border-0"
              >
                {existingTask.quality.toUpperCase()}
              </Badge>
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="center"
          className="bg-[#1a1a1a] border-white/10 rounded-lg"
        >
          <DropdownMenuItem
            onClick={handleDelete}
            className="text-red-400 focus:text-red-400 focus:bg-red-400/10 cursor-pointer"
          >
            <Trash2 className="size-4 mr-2" />
            Delete Download
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  if (isError) {
    return (
      <Button
        onClick={handleStart}
        variant="outline"
        className="h-11 px-5 rounded-lg border-amber-500/30 hover:bg-amber-500/10 text-amber-400 hover:text-amber-300 cursor-pointer"
      >
        <RotateCw className="size-5" />
        Retry Download
      </Button>
    );
  }

  if (isDownloading) {
    return (
      <Button
        disabled
        className="relative h-11 px-5 rounded-lg bg-sv-red hover:bg-sv-red-hover text-white font-semibold overflow-hidden cursor-default"
      >
        <span className="relative z-10 flex items-center gap-2">
          <Loader2 className="size-5 animate-spin" />
          Downloading {Math.round(progress)}%
        </span>
        <div
          className="absolute inset-0 bg-white/10 transition-all duration-300"
          style={{ width: `${100 - progress}%`, right: 0, left: 'auto' }}
        />
      </Button>
    );
  }

  // Default state — not downloaded
  return (
    <Button
      onClick={handleStart}
      variant="outline"
      className="h-11 px-5 rounded-lg border-white/[0.15] hover:bg-white/[0.1] text-[#F5F5F5] cursor-pointer"
    >
      <Download className="size-5" />
      Download
    </Button>
  );
}
