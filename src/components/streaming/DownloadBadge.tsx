'use client';

import { memo, useCallback } from 'react';
import { Download, Loader2 } from 'lucide-react';
import { useDownloadStore } from '@/store';

interface DownloadBadgeProps {
  contentId: string | number;
}

/**
 * Granular selectors: extract only the status string and progress number
 * for this contentId. Zustand uses Object.is for primitives — strings/numbers
 * won't trigger re-render unless the value actually changes.
 * This prevents ALL 20+ ContentCards from re-rendering when unrelated downloads progress.
 */
function useTaskStatus(contentId: string | number): { status: 'downloading' | 'completed' | ''; progress: number } {
  const cid = String(contentId);

  const status = useDownloadStore(
    useCallback(
      (s) => {
        const task = s.tasks.find(
          (t) => String(t.contentId) === cid && (t.status === 'downloading' || t.status === 'pending')
        );
        if (task) return 'downloading' as const;
        const done = s.tasks.find((t) => String(t.contentId) === cid && t.status === 'completed');
        return done ? ('completed' as const) : ('' as const);
      },
      [cid],
    ),
  );

  // Only subscribe to progress when status is 'downloading' — otherwise returns 0
  // which never triggers a re-render (0 === 0 → no update).
  const progress = useDownloadStore(
    useCallback(
      (s) => {
        if (status !== 'downloading') return 0;
        const task = s.tasks.find(
          (t) => String(t.contentId) === cid && (t.status === 'downloading' || t.status === 'pending')
        );
        return task?.progress ?? 0;
      },
      [cid, status],
    ),
  );

  return { status, progress };
}

const DownloadBadge = memo(function DownloadBadge({ contentId }: DownloadBadgeProps) {
  const { status, progress } = useTaskStatus(contentId);

  if (!status) return null;

  return (
    <div className="absolute bottom-2 right-2 z-10">
      {status === 'downloading' ? (
        <div className="flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-sv-red shadow-lg shadow-black/40">
          <Loader2 className="size-3 text-white animate-spin" />
          <span className="text-[10px] font-bold text-white leading-none">{Math.round(progress)}%</span>
        </div>
      ) : (
        <div className="w-6 h-6 rounded-full bg-sv-blue flex items-center justify-center shadow-lg shadow-black/40">
          <Download className="size-3.5 text-white fill-white" />
        </div>
      )}
    </div>
  );
});

export default DownloadBadge;
