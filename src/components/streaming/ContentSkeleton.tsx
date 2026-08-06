'use client';

import { Skeleton } from '@/components/ui/skeleton';

export function HeroSkeleton() {
  return (
    <div className="relative w-full min-h-[50vh] overflow-hidden">
      {/* Backdrop skeleton */}
      <div className="absolute inset-0 skeleton-shimmer" />

      {/* Gradient overlays */}
      <div className="absolute inset-0 hero-gradient-bottom" />
      <div className="absolute inset-0 hero-gradient-left" />

      {/* Content skeleton */}
      <div className="absolute bottom-16 left-4 right-4 max-w-2xl">
        <Skeleton className="h-4 w-20 mb-3 rounded bg-white/[0.08]" />
        <Skeleton className="h-8 w-[70%] mb-4 rounded bg-white/[0.08]" />
        <Skeleton className="h-4 w-32 mb-6 rounded bg-white/[0.08]" />
        <Skeleton className="h-16 w-full mb-4 rounded bg-white/[0.08]" />
        <div className="flex gap-3">
          <Skeleton className="h-10 w-28 rounded-lg bg-white/[0.08]" />
          <Skeleton className="h-10 w-28 rounded-lg bg-white/[0.08]" />
          <Skeleton className="h-10 w-28 rounded-lg bg-white/[0.08]" />
        </div>
      </div>
    </div>
  );
}

export function RowSkeleton() {
  return (
    <section className="mb-8">
      <div className="px-4 mb-4">
        <Skeleton className="h-7 w-48 rounded bg-white/[0.08]" />
      </div>
      <div className="flex gap-3 px-4 overflow-hidden">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="flex-shrink-0 w-[140px]">
            <div className="aspect-[2/3] rounded-lg skeleton-shimmer" />
            <div className="mt-2">
              <Skeleton className="h-3 w-24 rounded bg-white/[0.06]" />
              <Skeleton className="h-3 w-12 mt-1 rounded bg-white/[0.06]" />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

export function DetailSkeleton() {
  return (
    <div className="min-h-screen bg-[#080808]">
      {/* Hero section */}
      <div className="relative w-full h-[50vh] skeleton-shimmer" />
      <div className="absolute inset-0 hero-gradient-bottom" />

      {/* Content */}
      <div className="relative -mt-32 px-4 pb-12">
        <div className="flex flex-col gap-8">
          {/* Details */}
          <div className="flex-1 space-y-4">
            <Skeleton className="h-8 w-[60%] rounded bg-white/[0.08]" />
            <Skeleton className="h-4 w-40 rounded bg-white/[0.08]" />

            <div className="flex gap-3">
              <Skeleton className="h-10 w-28 rounded-lg bg-white/[0.08]" />
              <Skeleton className="h-10 w-32 rounded-lg bg-white/[0.08]" />
            </div>

            <Skeleton className="h-4 w-full rounded bg-white/[0.08]" />
            <Skeleton className="h-4 w-full rounded bg-white/[0.08]" />
            <Skeleton className="h-4 w-3/4 rounded bg-white/[0.08]" />
          </div>
        </div>

        {/* Cast section */}
        <div className="mt-10">
          <Skeleton className="h-7 w-32 mb-4 rounded bg-white/[0.08]" />
          <div className="flex gap-4 overflow-hidden">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="flex-shrink-0 flex flex-col items-center gap-2">
                <Skeleton className="w-16 h-16 rounded-full bg-white/[0.08]" />
                <Skeleton className="h-3 w-16 rounded bg-white/[0.06]" />
                <Skeleton className="h-3 w-12 rounded bg-white/[0.06]" />
              </div>
            ))}
          </div>
        </div>

        {/* Similar content */}
        <div className="mt-10">
          <Skeleton className="h-7 w-40 mb-4 rounded bg-white/[0.08]" />
          <div className="flex gap-3 overflow-hidden">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex-shrink-0 w-[140px]">
                <div className="aspect-[2/3] rounded-lg skeleton-shimmer" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export function GridSkeleton({ count = 12 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3 px-4">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i}>
          <div className="aspect-[2/3] rounded-lg skeleton-shimmer" />
          <div className="mt-2">
            <Skeleton className="h-3 w-24 rounded bg-white/[0.06]" />
            <Skeleton className="h-3 w-12 mt-1 rounded bg-white/[0.06]" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Search overlay grid — 3–5 cols, poster shimmer + title + metadata bar */
export function SearchGridSkeleton({ count = 10 }: { count?: number }) {
  return (
    <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-3">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i}>
          <div className="aspect-[2/3] w-full rounded-lg skeleton-shimmer" />
          <div className="mt-2">
            <Skeleton className="h-3 w-20 rounded bg-white/[0.06]" />
            <Skeleton className="h-3 w-14 mt-1 rounded bg-white/[0.04]" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Episode list — horizontal cards with thumbnail + text bars (TV detail page) */
export function EpisodeListSkeleton({ count = 5 }: { count?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="flex gap-4 p-3">
          <div className="w-[160px] aspect-video rounded-md flex-shrink-0 skeleton-shimmer" />
          <div className="flex-1 space-y-2 py-1">
            <Skeleton className="h-4 w-32 rounded bg-white/[0.06]" />
            <Skeleton className="h-3 w-16 rounded bg-white/[0.06]" />
            <Skeleton className="h-3 w-full rounded bg-white/[0.04]" />
            <Skeleton className="h-3 w-3/4 rounded bg-white/[0.04]" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Downloads page — header + storage bar + list card placeholders */
export function DownloadsSkeleton() {
  return (
    <div className="px-4 pt-8 pb-16">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <div className="w-10 h-10 rounded-xl bg-white/[0.06]" />
        <Skeleton className="h-7 w-40 rounded bg-white/[0.08]" />
      </div>
      {/* Storage bar */}
      <div className="mb-6">
        <Skeleton className="h-3 w-32 mb-2 rounded bg-white/[0.04]" />
        <div className="w-full h-1 rounded-full bg-white/[0.06]" />
      </div>
      {/* Download cards */}
      <div className="space-y-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 p-3 rounded-xl bg-white/[0.03] border border-white/[0.06]">
            <div className="w-[60px] h-[90px] rounded-lg flex-shrink-0 skeleton-shimmer" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-3/4 rounded bg-white/[0.06]" />
              <Skeleton className="h-3 w-1/2 rounded bg-white/[0.04]" />
              <Skeleton className="h-3 w-1/3 rounded bg-white/[0.04]" />
            </div>
            <div className="flex gap-2">
              <div className="w-8 h-8 rounded-lg bg-white/[0.06]" />
              <div className="w-8 h-8 rounded-lg bg-white/[0.06]" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
