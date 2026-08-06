'use client';

import { useEffect, useRef, useState } from 'react';
import { Home, Compass, Download, Heart, User } from 'lucide-react';
import { motion } from 'framer-motion';
import { useDownloadStore, useAuthStore } from '@/store';

interface MobileNavProps {
  onNavigate: (page: string) => void;
  currentPage: string;
}

const tabs = [
  { id: 'home', label: 'Home', icon: Home },
  { id: 'browse', label: 'Browse', icon: Compass },
  { id: 'downloads', label: 'Downloads', icon: Download },
  { id: 'mylist', label: 'My List', icon: Heart },
  { id: 'profile', label: 'Profile', icon: User },
];

// ── Profile avatar for nav bar ──────────────────────────────
// Loads from IndexedDB cache first (works offline), falls back
// to the Supabase URL. Matches the pattern used in ProfilePage.
function NavProfileAvatar({ active }: { active: boolean }) {
  const avatarUrl = useAuthStore((s) => s.profile?.avatar_url ?? null);
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const [src, setSrc] = useState<string | null>(null);
  const objectUrlRef = useRef<string | null>(null);

  useEffect(() => {
    if (!avatarUrl) {
      // No avatar set — clean up any previous object URL
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
      setSrc(null);
      return;
    }

    let cancelled = false;

    (async () => {
      // Try IndexedDB cache first (works offline)
      if (userId) {
        try {
          const { loadAvatar } = await import('@/lib/download-storage');
          const blob = await loadAvatar(userId);
          if (cancelled) return;
          if (blob) {
            if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
            const url = URL.createObjectURL(blob);
            objectUrlRef.current = url;
            setSrc(url);
            return;
          }
        } catch {
          // IndexedDB unavailable — fall through to network URL
        }
      }

      if (!cancelled) {
        setSrc(avatarUrl);
      }
    })();

    return () => { cancelled = true; };
  }, [avatarUrl, userId]);

  // Cleanup object URL on unmount
  useEffect(() => {
    return () => {
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
      }
    };
  }, []);

  if (!src) {
    // Fallback: default User icon
    return (
      <User
        className="size-[28px] transition-all duration-300"
        strokeWidth={active ? 2.2 : 1.5}
      />
    );
  }

  return (
    <div
      className={`
        size-[28px] rounded-full overflow-hidden transition-all duration-300
        ${active ? 'ring-2 ring-sv-red ring-offset-1 ring-offset-[rgba(30,30,30,0.65)]' : 'ring-1 ring-white/10'}
      `}
    >
      <img
        src={src}
        alt="Profile"
        className="w-full h-full object-cover"
        draggable={false}
      />
    </div>
  );
}

export default function MobileNav({ onNavigate, currentPage }: MobileNavProps) {
  // Granular selectors — only subscribe to primitive counts/numbers.
  // Zustand uses Object.is for primitives, so these only re-render
  // when the actual value changes (not on every progress tick).
  const activeDownloadCount = useDownloadStore(
    (s) => s.tasks.filter((t) => t.status === 'downloading' || t.status === 'pending').length,
  );
  const errorCount = useDownloadStore(
    (s) => s.tasks.filter((t) => t.status === 'error').length,
  );
  // Highest progress among active downloads (0-100 integer).
  // task.progress is already 0-100, so we just round to the nearest integer.
  // Zustand uses Object.is — returning the same integer skips the render.
  const topProgress = useDownloadStore((s) => {
    let max = 0;
    for (const t of s.tasks) {
      if (t.status === 'downloading' && t.progress > max) max = t.progress;
    }
    return Math.round(max);
  });

  const hasBadge = activeDownloadCount > 0 || errorCount > 0;

  const isActive = (tabId: string) => {
    if (tabId === 'home' && currentPage === 'home') return true;
    if (tabId === 'browse' && (currentPage === 'browse' || currentPage === 'movies' || currentPage === 'series')) return true;
    if (tabId === 'downloads' && currentPage === 'downloads') return true;
    if (tabId === 'mylist' && currentPage === 'mylist') return true;
    if (tabId === 'profile' && currentPage === 'profile') return true;
    return false;
  };

  const handleTabClick = (tabId: string, disabled: boolean | undefined) => {
    if (disabled) return;
    onNavigate(tabId);
  };

  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-50 flex justify-center"
      style={{
        pointerEvents: 'none',
        paddingBottom: '8px',
      }}
      aria-label="Mobile navigation"
    >
      <div
        className="flex items-center justify-center gap-4"
        style={{
          background: 'rgba(30, 30, 30, 0.65)',
          backdropFilter: 'blur(24px) saturate(180%)',
          WebkitBackdropFilter: 'blur(24px) saturate(180%)',
          boxShadow: '0 4px 30px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.06)',
          pointerEvents: 'auto',
          borderRadius: '24px',
          width: 'auto',
          padding: '0 18px',
          height: '54px',
        }}
      >
        {tabs.map((tab) => {
          const active = isActive(tab.id);
          const Icon = tab.icon;
          const showBadge = tab.id === 'downloads' && hasBadge;
          const isProfile = tab.id === 'profile';

          return (
            <button
              key={tab.id}
              onClick={() => handleTabClick(tab.id, tab.disabled)}
              disabled={tab.disabled}
              className={`
                relative flex items-center justify-center h-full
                transition-colors duration-200 cursor-pointer
                w-10
                ${tab.disabled ? 'opacity-30 cursor-not-allowed' : ''}
                ${active && !isProfile ? 'text-sv-red' : !isProfile ? 'text-[#555555]' : ''}
                ${!tab.disabled && !active && !isProfile ? 'active:text-[#888888]' : ''}
              `}
              style={{ minWidth: 0 }}
              aria-label={tab.label}
              aria-current={active ? 'page' : undefined}
            >
              <div className="relative flex items-center justify-center">
                <motion.div
                  whileTap={{ scale: 0.82 }}
                  transition={{ type: 'spring', damping: 20, stiffness: 400, mass: 0.6 }}
                >
                  {isProfile ? (
                    <NavProfileAvatar active={active} />
                  ) : (
                    <Icon
                      className="size-[28px] transition-all duration-300"
                      strokeWidth={active ? 2.2 : 1.5}
                    />
                  )}
                </motion.div>
                {/* Active indicator dot */}
                {active && (
                  <motion.div
                    layoutId="nav-active-dot"
                    className="absolute -bottom-1.5 w-1 h-1 rounded-full bg-sv-red"
                    transition={{ type: 'spring', damping: 25, stiffness: 350, mass: 0.8 }}
                  />
                )}
                {showBadge && (
                  <span
                    className={`
                      absolute -top-1.5 -right-2 min-w-[18px] h-[18px] rounded-full
                      flex items-center justify-center
                      text-[9px] font-bold leading-none px-1
                      ${activeDownloadCount > 0
                        ? 'bg-sv-red text-white'
                        : 'bg-amber-500 text-white'
                      }
                    `}
                  >
                    {activeDownloadCount > 0
                      ? `${Math.min(topProgress, 99)}%`
                      : errorCount > 0
                        ? errorCount
                        : null
                    }
                  </span>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
