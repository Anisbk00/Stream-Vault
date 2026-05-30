'use client';

import { useEffect, useRef, useState, type RefObject } from 'react';
import { Search, Shield } from 'lucide-react';

interface NavbarProps {
  onNavigate: (page: string) => void;
  currentPage: string;
  onSearchOpen: () => void;
  searchOpen: boolean;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  onSearchSubmit: (q: string) => void;
  /** Ref to the scrollable container (main element) — required for scroll detection */
  scrollRoot?: RefObject<HTMLElement | null>;
}

export default function Navbar({
  onNavigate,
  currentPage,
  onSearchOpen,
  searchQuery,
  onSearchChange,
  onSearchSubmit,
  scrollRoot,
}: NavbarProps) {
  const [scrolled, setScrolled] = useState(false);

  // Scroll detection: listen to the actual scrollable container.
  // The body has overflow:hidden, so IntersectionObserver on body sentinel
  // never fires. Instead, we watch scrollTop on the main scrollable element.
  useEffect(() => {
    const el = scrollRoot?.current;
    if (!el) return;

    const handler = () => setScrolled(el.scrollTop > 10);
    handler(); // Initial check

    el.addEventListener('scroll', handler, { passive: true });
    return () => el.removeEventListener('scroll', handler);
  }, [scrollRoot]);

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      onSearchSubmit(searchQuery);
    }
    if (e.key === 'Escape') {
      onSearchChange('');
      onSearchOpen();
    }
  };

  const showSearch = currentPage === 'home' || currentPage === 'browse' || currentPage === 'movies' || currentPage === 'series';

  return (
    <header
      className={`
        fixed top-0 left-0 right-0 z-50 transition-all duration-300 select-none-native
        ${scrolled ? 'glass border-b border-white/[0.08]' : 'bg-gradient-to-b from-black/80 to-transparent'}
      `}
    >
      <div className="flex items-center justify-between h-14 px-4">
        {/* Logo — hidden when search bar is showing */}
        <div className="items-center gap-8 flex">
          <button
            onClick={() => onNavigate('home')}
            className={`flex items-center gap-2 cursor-pointer group press-effect ${showSearch ? 'hidden' : 'flex'}`}
          >
            <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ backgroundColor: '#E50914' }}>
              <Shield className="size-4 text-white" strokeWidth={2} />
            </div>
            <span className="text-lg font-bold text-white tracking-tight">
              StreamVault
            </span>
          </button>
        </div>

        {/* Full-width search bar — same on all screens */}
        {showSearch && (
          <div className="flex-1 mx-1">
            <div className="flex items-center bg-[#1a1a1a] rounded-lg border border-white/[0.12] px-3">
              <Search className="size-4 text-[#606060] flex-shrink-0" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => onSearchChange(e.target.value)}
                onKeyDown={handleSearchKeyDown}
                onFocus={onSearchOpen}
                placeholder="Search movies, series..."
                className="bg-transparent text-sm text-[#F5F5F5] placeholder:text-[#606060] outline-none px-2 py-2 w-full"
              />
            </div>
          </div>
        )}
      </div>
    </header>
  );
}
