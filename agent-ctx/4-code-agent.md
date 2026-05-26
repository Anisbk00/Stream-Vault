# Task 4 - Fix StreamVault video player crashing in PWA mode

## Summary

Fixed three root causes of the video player crash in PWA mode:

1. **ErrorBoundary crash**: `getProviderLabel(allUrls[0])` crashed when `allUrls` was empty after `.filter(Boolean)`. The ErrorBoundary also swallowed errors without logging.

2. **PWA iframe failure**: External embed URLs loaded directly in iframes failed in PWA standalone mode due to CSP restrictions, Cloudflare challenges, and no shared cookies. Fixed by routing all embed URLs through `/api/stream/embed` proxy.

3. **404 errors / empty src**: Some movies don't exist on certain embed providers. Added defensive checks for empty src and fallback URL construction.

## Files Modified

1. `/home/z/my-project/src/components/streaming/VideoPlayer.tsx`
   - Added `wrapEmbedProxyUrl()` function
   - Defensive `allUrls` empty check
   - ErrorBoundary stores & displays error details
   - 15s timeout, sandbox attribute, removed referrerPolicy
   - Empty src fallback in main export

2. `/home/z/my-project/src/app/api/stream/embed/route.ts`
   - `<base href="ORIGINAL_DOMAIN">` tag injection
   - Permissive CSP headers + X-Frame-Options: ALLOWALL
   - Cache 300s → 600s
   - Timeout redirect fallback

3. `/home/z/my-project/src/components/streaming/StreamVaultApp.tsx`
   - `buildEmbedUrl` wraps through proxy
   - `buildFallbackList` wraps embed URLs through proxy
   - `handlePlay` / `handlePlayWithParams` defensive src guards + extra fallbacks

## Lint Status
✅ Passes clean
