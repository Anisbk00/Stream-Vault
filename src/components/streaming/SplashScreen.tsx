'use client';

import { motion } from 'framer-motion';
import RetroShield from './RetroShield';

/**
 * Premium vintage splash screen — 2-color, Apple-grade minimalism.
 * Displays while auth + data prefetch runs in the background.
 *
 * Palette: #080808 (void black) + #D97706 (retro amber)
 */

const BRAND = '#D97706';

export default function SplashScreen() {
  return (
    <motion.div
      className="fixed inset-0 z-[100] flex flex-col items-center justify-center bg-[#080808]"
      initial={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1] }}
      role="alert"
      aria-live="polite"
      aria-label="StreamVault is loading"
    >
      {/* Shield emblem */}
      <motion.div
        initial={{ opacity: 0, scale: 0.8 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
        className="mb-8"
      >
        <RetroShield
          className="size-14"
          style={{ color: BRAND }}
          strokeWidth={1.2}
        />
      </motion.div>

      {/* Brand name */}
      <motion.h1
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.7, delay: 0.3, ease: [0.22, 1, 0.36, 1] }}
        className="text-[2rem] font-bold tracking-[0.35em] uppercase"
        style={{ color: BRAND }}
      >
        StreamVault
      </motion.h1>

      {/* Thin gold rule */}
      <motion.div
        initial={{ scaleX: 0 }}
        animate={{ scaleX: 1 }}
        transition={{ duration: 0.8, delay: 0.55, ease: [0.22, 1, 0.36, 1] }}
        className="mt-3 h-[1px] w-16 origin-center"
        style={{ backgroundColor: BRAND }}
      />

      {/* VIP tagline */}
      <motion.p
        initial={{ opacity: 0 }}
        animate={{ opacity: 0.45 }}
        transition={{ duration: 0.9, delay: 0.75, ease: 'easeOut' }}
        className="mt-3 text-[0.65rem] font-medium tracking-[0.3em] uppercase"
        style={{ color: BRAND }}
      >
        VIP Access Only
      </motion.p>

      {/* Loading indicator — minimal pulse dot */}
      <motion.div
        className="mt-10"
        initial={{ opacity: 0 }}
        animate={{ opacity: 0.6 }}
        transition={{ duration: 0.5, delay: 1.0 }}
      >
        <motion.div
          className="h-1 w-1 rounded-full"
          style={{ backgroundColor: BRAND }}
          animate={{ opacity: [0.3, 1, 0.3] }}
          transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut' }}
        />
      </motion.div>
    </motion.div>
  );
}
