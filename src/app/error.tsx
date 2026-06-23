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
        style={{ backgroundColor: '#D97706' }}
      >
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 2L3 7V12C3 16.97 7.03 21.5 12 22.5C16.97 21.5 21 16.97 21 12V7L12 2Z" />
          <path d="M12 8L8.5 12L12 16L15.5 12L12 8Z" />
          <path d="M12 10L10.5 12L12 14L13.5 12L12 10Z" fill="white" opacity="0.9" />
        </svg>
      </div>
      <h1 className="text-xl font-bold text-white mb-2">Something went wrong</h1>
      <p className="text-sm text-[#808080] mb-6 text-center max-w-xs">
        An unexpected error occurred. This has been logged for investigation.
      </p>
      <button
        onClick={reset}
        className="px-6 py-3 rounded-xl text-white font-semibold text-sm transition-colors cursor-pointer"
        style={{ backgroundColor: '#D97706' }}
      >
        Try Again
      </button>
    </div>
  );
}
