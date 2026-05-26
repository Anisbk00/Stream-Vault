'use client';

import { useState, memo, useMemo, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Trash2, Play, Download, Loader2, HardDrive, AlertTriangle } from 'lucide-react';
import OfflinePoster from '@/components/streaming/OfflinePoster';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useDownloadStore, useUIStore } from '@/store';
import { formatBytes, formatEta } from '@/lib/hls-downloader';
import { cancelDownload } from '@/lib/download-service';
import type { DownloadTask } from '@/lib/hls-downloader';

interface DownloadPanelProps {
  isOpen: boolean;
  onClose: () => void;
  onPlayDownload?: (task: DownloadTask) => void;
}

type PanelTab = 'downloading' | 'completed';

function getTaskSubtitle(task: DownloadTask): string {
  if (task.season !== undefined && task.episode !== undefined) {
    return `S${task.season} E${task.episode}`;
  }
  if (task.season !== undefined) {
    return `Season ${task.season}`;
  }
  return '';
}

function getProgressText(task: DownloadTask): string {
  const parts = [`${Math.round(task.progress)}%`];
  if (task.totalBytes > 0) {
    parts.push(`${formatBytes(task.downloadedBytes)} / ${formatBytes(task.totalBytes)}`);
  } else {
    parts.push(formatBytes(task.downloadedBytes));
  }
  if (task.speed > 0) {
    parts.push(`${formatBytes(task.speed)}/s`);
  }
  if (task.eta > 0) {
    const eta = formatEta(task.eta);
    if (eta) parts.push(eta);
  }
  return parts.join(' · ');
}

// ── Memoized individual task card ──
// Each card only re-renders when its own task reference changes.
const DownloadingTaskCard = memo(function DownloadingTaskCard({
  task,
  onRemove,
}: {
  task: DownloadTask;
  onRemove: (id: string) => void;
}) {
  const progressText = task.status === 'pending' ? 'Preparing...' : getProgressText(task);

  return (
    <div className="flex gap-3 p-3 rounded-xl bg-white/[0.03] border border-white/[0.06]">
      {/* Poster thumbnail */}
      <div className="w-[60px] h-[90px] rounded-md overflow-hidden flex-shrink-0 bg-[#1a1a1a]">
        <OfflinePoster posterUrl={task.posterUrl} contentId={task.contentId} alt={task.title} className="w-full h-full object-cover" />
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0 flex flex-col justify-between py-0.5">
        <div className="min-w-0 pr-1">
          <h4 className="text-sm font-semibold text-[#F5F5F5] truncate">{task.title}</h4>
          {getTaskSubtitle(task) && (
            <p className="text-xs text-[#A0A0A0] mt-0.5">{getTaskSubtitle(task)}</p>
          )}
        </div>

        {/* Progress bar — plain div (no Framer Motion) to avoid animation cost on every tick */}
        <div>
          <div className="w-full h-1 rounded-full bg-white/[0.08] overflow-hidden">
            <div
              className="h-full rounded-full bg-sv-red transition-[width] duration-200"
              style={{ width: `${task.progress}%` }}
            />
          </div>
          <div className="flex items-center gap-1 mt-1">
            {task.status === 'pending' && (
              <Loader2 className="size-3 text-[#A0A0A0] animate-spin flex-shrink-0" />
            )}
            <p className="text-[11px] text-[#A0A0A0] truncate">{progressText}</p>
          </div>
        </div>
      </div>

      {/* Cancel button */}
      <Button
        onClick={() => onRemove(task.id)}
        variant="ghost"
        size="icon"
        className="size-8 flex-shrink-0 text-[#606060] hover:text-sv-red hover:bg-sv-red/10 rounded-full cursor-pointer self-start"
        aria-label="Cancel download"
      >
        <X className="size-4" />
      </Button>
    </div>
  );
});

// ── Error task card ──
const ErrorTaskCard = memo(function ErrorTaskCard({
  task,
  onRemove,
}: {
  task: DownloadTask;
  onRemove: (id: string) => void;
}) {
  return (
    <div className="flex gap-3 p-3 rounded-xl bg-amber-500/[0.04] border border-amber-500/10">
      {/* Poster thumbnail */}
      <div className="w-[60px] h-[90px] rounded-md overflow-hidden flex-shrink-0 bg-[#1a1a1a]">
        <OfflinePoster posterUrl={task.posterUrl} contentId={task.contentId} alt={task.title} className="w-full h-full object-cover" />
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0 flex flex-col justify-between py-0.5">
        <div className="min-w-0 pr-1">
          <h4 className="text-sm font-semibold text-[#F5F5F5] truncate">{task.title}</h4>
          {getTaskSubtitle(task) && (
            <p className="text-xs text-[#A0A0A0] mt-0.5">{getTaskSubtitle(task)}</p>
          )}
        </div>

        <div className="flex items-center gap-1.5">
          <AlertTriangle className="size-3 text-amber-400 flex-shrink-0" />
          <p className="text-[11px] text-amber-400 truncate">
            {task.error || 'Download failed'}
          </p>
        </div>
      </div>

      {/* Remove button */}
      <Button
        onClick={() => onRemove(task.id)}
        variant="ghost"
        size="icon"
        className="size-8 flex-shrink-0 text-[#606060] hover:text-red-400 hover:bg-red-400/10 rounded-full cursor-pointer self-start"
        aria-label="Remove failed download"
      >
        <X className="size-4" />
      </Button>
    </div>
  );
});

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

export default function DownloadPanel({ isOpen, onClose, onPlayDownload }: DownloadPanelProps) {
  const [activeTab, setActiveTab] = useState<PanelTab>('downloading');
  const { setDownloadPanelOpen } = useUIStore();

  // Subscribe to tasks (DownloadPanel is only rendered when opened, so this is fine)
  const tasks = useDownloadStore((s) => s.tasks);
  const removeTask = useDownloadStore((s) => s.removeTask);
  const getTotalDownloadedBytes = useDownloadStore((s) => s.getTotalDownloadedBytes);

  const downloadingTasks = useMemo(
    () => tasks.filter((t) => t.status === 'downloading' || t.status === 'pending'),
    [tasks],
  );
  const errorTasks = useMemo(
    () => tasks.filter((t) => t.status === 'error'),
    [tasks],
  );
  const completedTasks = useMemo(
    () => tasks.filter((t) => t.status === 'completed'),
    [tasks],
  );
  const totalBytes = getTotalDownloadedBytes();

  // Combined cancel: abort the in-flight fetch AND remove the task from store
  const handleCancelTask = useCallback(
    (taskId: string) => {
      cancelDownload(taskId);
      removeTask(taskId);
    },
    [removeTask],
  );

  const handleClose = () => {
    setDownloadPanelOpen(false);
    onClose();
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            key="download-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.25 }}
            className="fixed inset-0 z-[80] bg-black/60 backdrop-blur-sm"
            onClick={handleClose}
            aria-hidden="true"
          />

          {/* Drawer */}
          <motion.div
            key="download-drawer"
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ type: 'spring', damping: 30, stiffness: 300 }}
            drag="y"
            dragConstraints={{ top: 0 }}
            dragElastic={0.2}
            onDragEnd={(_, info) => {
              if (info.offset.y > 100) {
                handleClose();
              }
            }}
            className="fixed bottom-0 left-0 right-0 z-[90] flex flex-col bg-[#111111] border-t border-white/[0.08] rounded-t-2xl shadow-2xl shadow-black/80 safe-bottom safe-left safe-right"
            style={{ height: '70vh', maxHeight: '500px' }}
          >
            {/* Drag handle */}
            <div className="flex justify-center pt-3 pb-1 cursor-grab active:cursor-grabbing">
              <div className="w-10 h-1 rounded-full bg-white/20" />
            </div>

            {/* Header */}
            <div className="flex items-center justify-between px-5 pt-2 pb-3">
              <h2 className="text-lg font-bold text-[#F5F5F5] flex items-center gap-2">
                <Download className="size-5" />
                Downloads
              </h2>
              <Button
                onClick={handleClose}
                variant="ghost"
                size="icon"
                className="size-9 text-[#A0A0A0] hover:text-white hover:bg-white/10 rounded-full cursor-pointer"
                aria-label="Close downloads"
              >
                <X className="size-5" />
              </Button>
            </div>

            {/* Tabs */}
            <div className="flex gap-1 px-5 mb-3">
              <button
                onClick={() => setActiveTab('downloading')}
                className={`
                  relative px-4 py-2 text-sm font-semibold rounded-lg transition-colors cursor-pointer
                  ${activeTab === 'downloading'
                    ? 'text-white'
                    : 'text-[#606060] hover:text-[#A0A0A0]'
                  }
                `}
              >
                {activeTab === 'downloading' && (
                  <motion.div
                    layoutId="download-tab-indicator"
                    className="absolute inset-0 bg-white/10 rounded-lg"
                    transition={{ type: 'spring', duration: 0.35 }}
                  />
                )}
                <span className="relative z-10 flex items-center">
                  Downloading
                  {(downloadingTasks.length + errorTasks.length) > 0 && (
                    <span className="ml-1.5 bg-sv-red text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full leading-none">
                      {downloadingTasks.length + errorTasks.length}
                    </span>
                  )}
                </span>
              </button>

              <button
                onClick={() => setActiveTab('completed')}
                className={`
                  relative px-4 py-2 text-sm font-semibold rounded-lg transition-colors cursor-pointer
                  ${activeTab === 'completed'
                    ? 'text-white'
                    : 'text-[#606060] hover:text-[#A0A0A0]'
                  }
                `}
              >
                {activeTab === 'completed' && (
                  <motion.div
                    layoutId="download-tab-indicator"
                    className="absolute inset-0 bg-white/10 rounded-lg"
                    transition={{ type: 'spring', duration: 0.35 }}
                  />
                )}
                <span className="relative z-10">Completed</span>
              </button>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto px-5 custom-scrollbar">
              <AnimatePresence mode="wait">
                {activeTab === 'downloading' && (
                  <motion.div
                    key="tab-downloading"
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -10 }}
                    transition={{ duration: 0.2 }}
                  >
                    {downloadingTasks.length === 0 && errorTasks.length === 0 ? (
                      <div className="flex flex-col items-center justify-center h-full gap-3 py-12">
                        <div className="w-16 h-16 rounded-full bg-white/[0.05] flex items-center justify-center">
                          <Download className="size-7 text-[#404040]" />
                        </div>
                        <p className="text-[#A0A0A0] text-sm text-center">
                          No active downloads
                        </p>
                        <p className="text-[#606060] text-xs text-center max-w-[200px]">
                          Download movies and series to watch them offline
                        </p>
                      </div>
                    ) : (
                      <div className="space-y-3 pb-4">
                        {downloadingTasks.map((task) => (
                          <DownloadingTaskCard key={task.id} task={task} onRemove={handleCancelTask} />
                        ))}
                        {errorTasks.map((task) => (
                          <ErrorTaskCard key={task.id} task={task} onRemove={handleCancelTask} />
                        ))}
                      </div>
                    )}
                  </motion.div>
                )}

                {activeTab === 'completed' && (
                  <motion.div
                    key="tab-completed"
                    initial={{ opacity: 0, x: 10 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 10 }}
                    transition={{ duration: 0.2 }}
                  >
                    {completedTasks.length === 0 ? (
                      <div className="flex flex-col items-center justify-center h-full gap-3 py-12">
                        <div className="w-16 h-16 rounded-full bg-white/[0.05] flex items-center justify-center">
                          <HardDrive className="size-7 text-[#404040]" />
                        </div>
                        <p className="text-[#A0A0A0] text-sm text-center">
                          No completed downloads
                        </p>
                        <p className="text-[#606060] text-xs text-center max-w-[200px]">
                          Your downloaded content will appear here
                        </p>
                      </div>
                    ) : (
                      <div className="space-y-3 pb-4">
                        {completedTasks.map((task) => (
                          <CompletedTaskCard
                            key={task.id}
                            task={task}
                            onPlay={onPlayDownload ?? (() => {})}
                            onRemove={removeTask}
                          />
                        ))}
                      </div>
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* Storage info footer */}
            <div className="flex items-center justify-center gap-2 px-5 py-3 border-t border-white/[0.06] bg-[#0a0a0a]">
              <HardDrive className="size-3.5 text-[#606060]" />
              <span className="text-xs text-[#606060]">
                {formatBytes(totalBytes)} downloaded
              </span>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
