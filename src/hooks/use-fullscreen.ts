'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

interface UseFullscreenOptions {
  /** Auto-enter fullscreen when element mounts or trigger changes */
  autoEnter?: boolean;
  /** Exit fullscreen on component unmount */
  exitOnUnmount?: boolean;
}

interface UseFullscreenReturn {
  /** Whether the document is currently in fullscreen mode */
  isFullscreen: boolean;
  /** Whether fullscreen is supported by the browser */
  isSupported: boolean;
  /** Enter fullscreen mode on the target element */
  enterFullscreen: () => Promise<void>;
  /** Exit fullscreen mode */
  exitFullscreen: () => Promise<void>;
  /** Toggle fullscreen mode */
  toggleFullscreen: () => Promise<void>;
  /** Ref to attach to the target element */
  ref: React.RefObject<HTMLElement | null>;
}

export function useFullscreen(options: UseFullscreenOptions = {}): UseFullscreenReturn {
  const { autoEnter = false, exitOnUnmount = false } = options;
  const ref = useRef<HTMLElement | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  // Check support on mount — use callback ref pattern to avoid setState in effect
  const [isSupported] = useState(() => {
    if (typeof document === 'undefined') return false;
    return !!(
      document.fullscreenEnabled ||
      (document as unknown as Record<string, unknown>).webkitFullscreenEnabled ||
      (document as unknown as Record<string, unknown>).mozFullScreenEnabled
    );
  });

  // Listen for fullscreen changes
  useEffect(() => {
    const handleChange = () => {
      const fullEl =
        document.fullscreenElement ||
        (document as unknown as Record<string, unknown>).webkitFullscreenElement ||
        (document as unknown as Record<string, unknown>).mozFullScreenElement;
      setIsFullscreen(!!fullEl);
    };

    document.addEventListener('fullscreenchange', handleChange);
    document.addEventListener('webkitfullscreenchange', handleChange);
    document.addEventListener('mozfullscreenchange', handleChange);

    return () => {
      document.removeEventListener('fullscreenchange', handleChange);
      document.removeEventListener('webkitfullscreenchange', handleChange);
      document.removeEventListener('mozfullscreenchange', handleChange);
    };
  }, []);

  const enterFullscreen = useCallback(async () => {
    const el = ref.current;
    if (!el) return;

    try {
      if ((el as unknown as Record<string, unknown>).requestFullscreen) {
        await el.requestFullscreen();
      } else if ((el as unknown as Record<string, () => Promise<void>>).webkitRequestFullscreen) {
        await el.webkitRequestFullscreen();
      } else if ((el as unknown as Record<string, () => Promise<void>>).mozRequestFullScreen) {
        await el.mozRequestFullScreen();
      }
    } catch {
      // fullscreen not available — silently fail
    }
  }, []);

  const exitFullscreen = useCallback(async () => {
    try {
      if (document.exitFullscreen) {
        await document.exitFullscreen();
      } else if ((document as unknown as Record<string, () => Promise<void>>).webkitExitFullscreen) {
        await (document as unknown as Record<string, () => Promise<void>>).webkitExitFullscreen();
      } else if ((document as unknown as Record<string, () => Promise<void>>).mozCancelFullScreen) {
        await (document as unknown as Record<string, () => Promise<void>>).mozCancelFullScreen();
      }
    } catch {
      // ignore
    }
  }, []);

  const toggleFullscreen = useCallback(async () => {
    if (isFullscreen) {
      await exitFullscreen();
    } else {
      await enterFullscreen();
    }
  }, [isFullscreen, enterFullscreen, exitFullscreen]);

  // Auto-enter fullscreen
  useEffect(() => {
    if (autoEnter && ref.current && isSupported) {
      // Small delay to allow the element to render
      const timer = setTimeout(() => {
        enterFullscreen();
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [autoEnter, isSupported, enterFullscreen]);

  // Exit on unmount
  useEffect(() => {
    if (exitOnUnmount) {
      return () => {
        exitFullscreen();
      };
    }
  }, [exitOnUnmount, exitFullscreen]);

  return {
    isFullscreen,
    isSupported,
    enterFullscreen,
    exitFullscreen,
    toggleFullscreen,
    ref,
  };
}

/**
 * Lock the screen orientation (useful for video player).
 * Returns a function to unlock.
 */
export async function lockOrientation(orientation: OrientationLockType): Promise<boolean> {
  try {
    if (screen.orientation && screen.orientation.lock) {
      await screen.orientation.lock(orientation);
      return true;
    }
  } catch {
    // orientation lock not supported
  }
  return false;
}

/**
 * Unlock screen orientation.
 */
export async function unlockOrientation(): Promise<void> {
  try {
    if (screen.orientation && screen.orientation.unlock) {
      screen.orientation.unlock();
    }
  } catch {
    // ignore
  }
}

/**
 * Request wake lock to prevent screen from sleeping during playback.
 * Returns a function to release.
 */
export async function requestWakeLock(): Promise<() => void> {
  try {
    if ('wakeLock' in navigator) {
      const wakeLock = await (navigator as unknown as { wakeLock: { request: (type: string) => Promise<unknown> } }).wakeLock.request('screen');
      return () => {
        (wakeLock as unknown as { release: () => Promise<void> }).release?.();
      };
    }
  } catch {
    // wake lock not supported
  }
  return () => {};
}
