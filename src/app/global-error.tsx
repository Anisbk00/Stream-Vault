'use client';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        className="min-h-dvh flex flex-col items-center justify-center bg-[#080808] text-[#F5F5F5] px-6"
        style={{ fontFamily: 'system-ui, sans-serif' }}
      >
        <div className="w-14 h-14 rounded-2xl flex items-center justify-center mb-6"
          style={{ backgroundColor: '#E50914' }}
        >
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="15" y1="9" x2="9" y2="15" />
            <line x1="9" y1="9" x2="15" y2="15" />
          </svg>
        </div>
        <h1 className="text-xl font-bold text-white mb-2">Application Error</h1>
        <p className="text-sm text-[#808080] mb-6 text-center max-w-xs">
          A critical error occurred. Please refresh the page.
        </p>
        <button
          onClick={reset}
          className="px-6 py-3 rounded-xl text-white font-semibold text-sm transition-colors cursor-pointer"
          style={{ backgroundColor: '#E50914' }}
        >
          Refresh
        </button>
      </body>
    </html>
  );
}
