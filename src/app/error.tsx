'use client';

import { useEffect } from 'react';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[StreamVault] Unhandled error:', error);
  }, [error]);

  return (
    <div
      className="min-h-dvh flex flex-col items-center justify-center bg-[#080808] text-[#F5F5F5] px-6"
      style={{ fontFamily: 'var(--font-geist-sans, system-ui, sans-serif)' }}
    >
      <div className="w-14 h-14 rounded-2xl flex items-center justify-center mb-6"
        style={{ backgroundColor: '#E50914' }}
      >
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
          <line x1="12" y1="9" x2="12" y2="13" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
      </div>
      <h1 className="text-xl font-bold text-white mb-2">Something went wrong</h1>
      <p className="text-sm text-[#808080] mb-6 text-center max-w-xs">
        An unexpected error occurred. This has been logged for investigation.
      </p>
      <button
        onClick={reset}
        className="px-6 py-3 rounded-xl text-white font-semibold text-sm transition-colors cursor-pointer"
        style={{ backgroundColor: '#E50914' }}
      >
        Try Again
      </button>
    </div>
  );
}
