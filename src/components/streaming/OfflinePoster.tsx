'use client';

import { useState, useEffect, useRef } from 'react';
import { Download } from 'lucide-react';

interface OfflinePosterProps {
  posterUrl?: string;
  contentId: string | number;
  alt: string;
  className?: string;
  sizeClass?: string; // e.g., 'w-[60px] h-[90px]'
}

/**
 * Renders a poster image that works offline.
 * Checks IndexedDB for a cached poster blob first.
 * Falls back to the original URL if no cached version exists.
 */
export default function OfflinePoster({ posterUrl, contentId, alt, className, sizeClass }: OfflinePosterProps) {
  const [src, setSrc] = useState<string | undefined>(undefined);
  const blobUrlRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;

    async function loadCachedPoster() {
      try {
        const { loadPoster } = await import('@/lib/download-storage');
        const blob = await loadPoster(contentId);
        if (cancelled) return;
        if (blob) {
          const url = URL.createObjectURL(blob);
          blobUrlRef.current = url;
          setSrc(url);
          return;
        }
      } catch {
        // IndexedDB not available or read failed
      }
      // No cached poster — use original URL (works online)
      if (!cancelled) {
        setSrc(posterUrl);
      }
    }

    loadCachedPoster();

    return () => {
      cancelled = true;
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = undefined;
      }
    };
  }, [contentId, posterUrl]);

  if (!src) {
    // Loading state or no poster
    return (
      <div className={`${className || ''} bg-[#1a1a1a] flex items-center justify-center ${sizeClass || ''}`}>
        <Download className="size-5 text-[#404040]" />
      </div>
    );
  }

  return (
    <img src={src} alt={alt} className={`${className || ''} ${sizeClass || ''}`} loading="lazy" />
  );
}
