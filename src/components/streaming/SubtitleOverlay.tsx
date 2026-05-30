'use client';

import { motion, AnimatePresence } from 'framer-motion';
import type { SubtitleCue } from '@/types/subtitles';

interface SubtitleOverlayProps {
  /** The current subtitle cue to display (null = no subtitle) */
  cue: SubtitleCue | null;
  /** Subtitle time offset in seconds (displayed to user) */
  offset: number;
  /** Whether the subtitle system is currently loading */
  loading: boolean;
  /** Error message to display */
  error: string | null;
}

export function SubtitleOverlay({ cue, offset, loading, error }: SubtitleOverlayProps) {
  // Don't render anything if there's no content to show
  if (!cue && !loading && !error) return null;

  return (
    <div className="absolute bottom-16 left-0 right-0 z-[108] flex flex-col items-center pointer-events-none px-4 pb-2">
      <AnimatePresence mode="wait">
        {cue && (
          <motion.div
            key={cue.start}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.15 }}
            className="max-w-[85%] text-center"
          >
            <p className="text-white text-base md:text-lg leading-relaxed px-4 py-1.5 rounded-md"
              style={{
                textShadow: '0 1px 3px rgba(0,0,0,0.9), 0 0 8px rgba(0,0,0,0.7)',
              }}
            >
              {cue.text}
            </p>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Error/loading indicator (small, non-intrusive) */}
      {error && !cue && (
        <p className="text-red-400 text-xs bg-black/60 px-2 py-1 rounded">{error}</p>
      )}
      {loading && !cue && (
        <p className="text-white/60 text-xs bg-black/60 px-2 py-1 rounded">Loading subtitles…</p>
      )}
    </div>
  );
}
