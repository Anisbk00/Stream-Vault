'use client';

import { useMemo, memo, useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Download, Play, Trash2, Film, HardDrive, Loader2, WifiOff, AlertTriangle } from 'lucide-react';
import { DownloadsSkeleton } from './ContentSkeleton';
import OfflinePoster from '@/components/streaming/OfflinePoster';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useDownloadStore, useAuthStore } from '@/store';
import { formatBytes } from '@/lib/hls-downloader';
import { cancelDownload } from '@/lib/download-service';
import type { DownloadTask } from '@/lib/hls-downloader';

interface DownloadsPageProps {
  onNavigate: (page: string, id?: string | number) => void;
  onPlayDownload: (task: DownloadTask) => void;
}

// ── Helpers ─────────────────────────────────────────────────

function getTaskSubtitle(task: DownloadTask): string {
  if (task.season !== undefined && task.episode !== undefined) {
    return `S${task.season} E${task.episode}`;
  }
  if (task.season !== undefined) {
    return `Season ${task.season}`;
  }
  return '';
}

// ── Grouping helpers ─────────────────────────────────────────

interface MovieGroup {
  type: 'movie';
  task: DownloadTask;
}

interface SeriesGroup {
  type: 'series';
  title: string;
  posterUrl?: string;
  contentId: string | number;
  mediaType: 'movie' | 'tv';
  year?: string;
  episodes: DownloadTask[];
}

type DownloadGroup = MovieGroup | SeriesGroup;

function groupDownloads(tasks: DownloadTask[]): DownloadGroup[] {
  const groups: DownloadGroup[] = [];
  const seriesMap = new Map<string, SeriesGroup>();

  for (const task of tasks) {
    if (task.status !== 'completed') continue;

    if (task.mediaType === 'movie' || task.season === undefined) {
      groups.push({ type: 'movie', task });
    } else {
      const key = `${task.contentId}`;
      let group = seriesMap.get(key);
      if (!group) {
        group = {
          type: 'series',
          title: task.title,
          posterUrl: task.posterUrl,
          contentId: task.contentId,
          mediaType: task.mediaType,
          year: task.year,
          episodes: [],
        };
        seriesMap.set(key, group);
        groups.push(group);
      }
      group.episodes.push(task);
    }
  }

  return groups;
}

function sortEpisodes(episodes: DownloadTask[]): DownloadTask[] {
  return [...episodes].sort((a, b) => {
    if (a.season !== b.season) return (a.season ?? 0) - (b.season ?? 0);
    return (a.episode ?? 0) - (b.episode ?? 0);
  });
}

// ── Animation variants ──────────────────────────────────────

const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { staggerChildren: 0.06 },
  },
};

const itemVariants = {
  hidden: { opacity: 0, y: 20, scale: 0.97 },
  visible: {
    opacity: 1, y: 0, scale: 1,
    transition: { type: 'spring', damping: 25, stiffness: 300, mass: 0.8 },
  },
  exit: {
    opacity: 0, scale: 0.9,
    transition: { duration: 0.2 },
  },
};

// ── Completed Task Card (list-card format — poster + info + actions) ──

const CompletedTaskCard = memo(function CompletedTaskCard({
  task,
  onPlay,
  onRemove,
}: {
  task: DownloadTask;
  onPlay: (task: DownloadTask) => void;
  onRemove: (id: string) => void;
}) {
  const subtitle = getTaskSubtitle(task);
  const canPlay = !!task.hasLocalCopy;

  return (
    <div className="flex gap-3 p-3 rounded-xl bg-white/[0.03] border border-white/[0.06]">
      {/* Poster thumbnail */}
      <div className="w-[60px] h-[90px] rounded-md overflow-hidden flex-shrink-0 bg-[#1a1a1a]">
        <OfflinePoster posterUrl={task.posterUrl} contentId={task.contentId} alt={task.title} className="w-full h-full object-cover" />
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0 flex flex-col justify-between py-0.5">
        <div className="min-w-0">
          <h4 className="text-sm font-semibold text-[#F5F5F5] truncate">{task.title}</h4>
          <div className="flex items-center gap-2 mt-1">
            {subtitle && <span className="text-xs text-[#A0A0A0]">{subtitle}</span>}
            <Badge
              variant="secondary"
              className="bg-white/10 text-[#A0A0A0] text-[10px] uppercase font-semibold px-1.5 py-0 border-0"
            >
              {task.quality}
            </Badge>
            {task.downloadedBytes > 0 && (
              <span className="text-[10px] text-[#606060]">{formatBytes(task.downloadedBytes)}</span>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2 flex-wrap">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onPlay(task)}
            disabled={!canPlay}
            className={`h-8 px-3 rounded-lg text-xs font-medium cursor-pointer ${canPlay ? 'text-[#A0A0A0] hover:text-white hover:bg-white/10' : 'text-[#404040] cursor-not-allowed'}`}
            aria-label={canPlay ? 'Play downloaded content' : 'Content not available'}
            title={canPlay ? 'Play' : 'Re-download required'}
          >
            <Play className="size-3.5 mr-1" />
            Play
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onRemove(task.id)}
            className="h-8 px-3 text-[#A0A0A0] hover:text-sv-red hover:bg-sv-red/10 rounded-lg text-xs font-medium cursor-pointer"
            aria-label="Delete download"
          >
            <Trash2 className="size-3.5 mr-1" />
            Delete
          </Button>
        </div>
      </div>
    </div>
  );
});

// ── Series Group ────────────────────────────────────────────

const SeriesGroupCard = memo(function SeriesGroupCard({
  group,
  onPlay,
  onRemove,
}: {
  group: SeriesGroup;
  onPlay: (task: DownloadTask) => void;
  onRemove: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const sortedEpisodes = useMemo(() => sortEpisodes(group.episodes), [group.episodes]);

  return (
    <motion.div
      variants={itemVariants}
      exit="exit"
      className="bg-white/[0.03] border border-white/[0.06] rounded-xl overflow-hidden"
    >
      {/* Show header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-3 p-3 hover:bg-white/[0.02] transition-colors cursor-pointer"
      >
        {/* Poster thumbnail */}
        <div className="w-[48px] h-[72px] rounded-md overflow-hidden flex-shrink-0 bg-[#1a1a1a]">
          <OfflinePoster posterUrl={group.posterUrl} contentId={group.contentId} alt={group.title} className="w-full h-full object-cover" />
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0 text-left">
          <h3 className="text-sm font-semibold text-[#F5F5F5] truncate">{group.title}</h3>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-[11px] text-[#A0A0A0]">
              {group.episodes.length} episode{group.episodes.length > 1 ? 's' : ''}
            </span>
          </div>
        </div>

        {/* Chevron */}
        <svg
          className={`w-4 h-4 text-[#606060] transition-transform duration-200 flex-shrink-0 ${expanded ? 'rotate-180' : ''}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Episodes list */}
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: [0.32, 0.72, 0, 1] }}
            className="overflow-hidden"
          >
            <div className="border-t border-white/[0.06] space-y-2 p-2">
              {sortedEpisodes.map((ep) => (
                <CompletedTaskCard
                  key={ep.id}
                  task={ep}
                  onPlay={onPlay}
                  onRemove={onRemove}
                />
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
});

// ── Active Downloads Summary ─────────────────────────────────

function ActiveDownloadsSummary({ tasks, onRemove }: { tasks: DownloadTask[]; onRemove: (id: string) => void }) {
  if (tasks.length === 0) return null;

  return (
    <motion.div variants={itemVariants} className="mb-6">
      <h2 className="text-xs font-semibold text-[#606060] uppercase tracking-wider mb-3 px-1">
        Active Downloads
      </h2>
      <div className="space-y-2">
        {tasks.map((task) => {
          const isPending = task.status === 'pending';
          const isError = task.status === 'error';
          const progress = task.progress;
          const epLabel = task.season !== undefined && task.episode !== undefined
            ? ` S${String(task.season).padStart(2, '0')}E${String(task.episode).padStart(2, '0')}`
            : '';

          return (
            <div
              key={task.id}
              className={`flex gap-3 p-3 rounded-xl ${
                isError ? 'bg-amber-500/[0.04] border border-amber-500/10' : 'bg-white/[0.03] border border-white/[0.06]'
              }`}
            >
              {/* Poster thumbnail */}
              <div className="w-[60px] h-[90px] rounded-md overflow-hidden flex-shrink-0 bg-[#1a1a1a]">
                <OfflinePoster posterUrl={task.posterUrl} contentId={task.contentId} alt={task.title} className="w-full h-full object-cover" />
              </div>

              {/* Info */}
              <div className="flex-1 min-w-0 flex flex-col justify-between py-0.5">
                <div className="min-w-0 pr-1">
                  <h4 className="text-sm font-semibold text-[#F5F5F5] truncate">
                    {task.title}{epLabel}
                  </h4>
                  {isError ? (
                    <p className="text-[11px] text-amber-400 truncate mt-0.5">
                      {task.error || 'Download failed'}
                    </p>
                  ) : (
                    <div className="flex items-center gap-1 mt-1">
                      {isPending && (
                        <Loader2 className="size-3 text-[#A0A0A0] animate-spin flex-shrink-0" />
                      )}
                      <p className="text-[11px] text-[#A0A0A0] truncate">
                        {isPending ? 'Preparing...' : `${Math.round(progress)}% · ${formatBytes(task.downloadedBytes)}`}
                      </p>
                    </div>
                  )}
                </div>

                {/* Progress bar */}
                {!isPending && !isError && (
                  <div className="w-full h-1 rounded-full bg-white/[0.08] overflow-hidden">
                    <div
                      className="h-full rounded-full bg-sv-red transition-[width] duration-300"
                      style={{ width: `${progress}%` }}
                    />
                  </div>
                )}

                {/* Cancel button for error tasks */}
                {isError && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => { cancelDownload(task.id); onRemove(task.id); }}
                    className="h-8 px-3 text-[#A0A0A0] hover:text-sv-red hover:bg-sv-red/10 rounded-lg text-xs font-medium cursor-pointer self-start"
                  >
                    <Trash2 className="size-3.5 mr-1" />
                    Remove
                  </Button>
                )}
              </div>

              {/* Cancel button for active downloads */}
              {!isPending && !isError && (
                <button
                  onClick={() => { cancelDownload(task.id); onRemove(task.id); }}
                  className="flex items-center justify-center w-8 h-8 rounded-full flex-shrink-0 text-[#606060] hover:text-sv-red hover:bg-sv-red/10 transition-all cursor-pointer self-start"
                  aria-label="Cancel download"
                >
                  <Trash2 className="size-4" />
                </button>
              )}
            </div>
          );
        })}
      </div>
    </motion.div>
  );
}

// ── Main Page ───────────────────────────────────────────────

export default function DownloadsPage({ onNavigate, onPlayDownload }: DownloadsPageProps) {
  const tasks = useDownloadStore((s) => s.tasks);
  const removeTask = useDownloadStore((s) => s.removeTask);
  const getTotalDownloadedBytes = useDownloadStore((s) => s.getTotalDownloadedBytes);
  const isOffline = useAuthStore((s) => s.isOffline);

  // Wait for Zustand persist rehydration before rendering content.
  // Without this, the page flashes "No downloads yet" on every mount
  // (logout/login, tab switch, navigation) because the store starts
  // with tasks=[] before localStorage rehydration completes.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    const markHydrated = () => setHydrated(true);
    if (useDownloadStore.persist.hasHydrated()) {
      markHydrated();
      return;
    }
    const unsub = useDownloadStore.persist.onFinishHydration(markHydrated);
    return unsub;
  }, []);

  const completedTasks = useMemo(() => tasks.filter(t => t.status === 'completed'), [tasks]);
  const activeTasks = useMemo(() => tasks.filter(t => t.status === 'downloading' || t.status === 'pending' || t.status === 'error'), [tasks]);
  const groups = useMemo(() => groupDownloads(completedTasks), [completedTasks]);
  const movieGroups = useMemo(() => groups.filter(g => g.type === 'movie'), [groups]);
  const seriesGroups = useMemo(() => groups.filter(g => g.type === 'series'), [groups]);

  const totalBytes = getTotalDownloadedBytes();
  const hasContent = completedTasks.length > 0 || activeTasks.length > 0;

  return (
    <section className="min-h-[calc(100dvh-1rem)] bg-[#080808]">
      {/* Page header */}
      <div className="px-4 pt-8 mb-2">
        <motion.div
          initial={{ opacity: 0, y: -12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
          className="flex items-center gap-3"
        >
          <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-sv-blue/15">
            <Download className="size-5 text-sv-blue" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-[#F5F5F5]">My Downloads</h1>
          </div>
          {completedTasks.length > 0 && (
            <Badge variant="secondary" className="bg-white/10 text-[#A0A0A0] text-xs font-semibold px-2.5 py-0.5 rounded-full">
              {completedTasks.length}
            </Badge>
          )}
        </motion.div>
      </div>

      {/* Storage bar */}
      {hasContent && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.4, delay: 0.1 }}
          className="mx-4 mb-6"
        >
          <div className="flex items-center gap-2 mb-1.5">
            <HardDrive className="size-3.5 text-[#606060]" />
            <span className="text-[11px] text-[#606060]">{formatBytes(totalBytes)} total storage</span>
          </div>
          <div className="w-full h-1 rounded-full bg-white/[0.06] overflow-hidden">
            <div
              className="h-full rounded-full bg-sv-blue/60 transition-all duration-500"
              style={{ width: '100%' }}
            />
          </div>
        </motion.div>
      )}

      {/* Offline banner */}
      {isOffline && completedTasks.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          className="mx-4 mb-5 flex items-center gap-2 px-3 py-2.5 rounded-xl bg-amber-500/[0.06] border border-amber-500/15"
        >
          <WifiOff className="size-4 text-amber-400 flex-shrink-0" />
          <span className="text-xs text-amber-400/90">
            You&apos;re offline — playing downloaded content only.
          </span>
        </motion.div>
      )}

      {/* Loading state — waiting for persist rehydration */}
      {!hydrated && <DownloadsSkeleton />}

      {/* Empty state — only show after hydration confirms no downloads */}
      {hydrated && !hasContent && (
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.15 }}
          className="flex flex-col items-center justify-center text-center px-6 py-20 md:py-32"
        >
          <div className="relative mb-6">
            <div className="flex items-center justify-center w-24 h-24 rounded-full bg-white/[0.05]">
              <Download className="size-10 text-[#606060]" />
            </div>
            <div className="absolute -top-1 -right-1 flex items-center justify-center w-8 h-8 rounded-full bg-white/[0.05]">
              <Film className="size-4 text-[#606060]" />
            </div>
          </div>

          <h2 className="text-xl font-semibold text-[#F5F5F5] mb-2">No downloads yet</h2>
          <p className="text-sm text-[#606060] max-w-sm mb-8 leading-relaxed">
            Download movies and series to watch them offline. Tap the download button on any movie or episode.
          </p>

          <Button
            onClick={() => onNavigate('browse')}
            className="bg-sv-red hover:bg-sv-red-hover text-white font-semibold h-11 px-8 rounded-lg text-sm cursor-pointer"
          >
            <Play className="size-4 mr-2 fill-white" />
            Browse Content
          </Button>
        </motion.div>
      )}

      {/* Content — only render after hydration to prevent flash */}
      {hydrated && hasContent && (
        <AnimatePresence mode="wait">
          <motion.div
            key="downloads-content"
            variants={containerVariants}
            initial="hidden"
            animate="visible"
            className="px-4"
          >
            {/* Active downloads */}
            <ActiveDownloadsSummary tasks={activeTasks} onRemove={removeTask} />

            {/* Movies section */}
            {movieGroups.length > 0 && (
              <div className="mb-6">
                <h2 className="text-xs font-semibold text-[#606060] uppercase tracking-wider mb-3 px-1">
                  Movies
                </h2>
                <div className="space-y-2">
                  {movieGroups.map((g) => (
                    <CompletedTaskCard
                      key={g.task.id}
                      task={g.task}
                      onPlay={onPlayDownload}
                      onRemove={removeTask}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* TV Shows section */}
            {seriesGroups.length > 0 && (
              <div className="mb-6">
                <h2 className="text-xs font-semibold text-[#606060] uppercase tracking-wider mb-3 px-1">
                  TV Shows
                </h2>
                <div className="space-y-3">
                  {seriesGroups.map((g) => (
                    <SeriesGroupCard
                      key={String(g.contentId)}
                      group={g}
                      onPlay={onPlayDownload}
                      onRemove={removeTask}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Bottom spacer */}
            <div className="h-4" />
          </motion.div>
        </AnimatePresence>
      )}
    </section>
  );
}
