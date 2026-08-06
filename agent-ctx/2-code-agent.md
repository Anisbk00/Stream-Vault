# Task 2 - Fix StreamVault Source API

## Agent: code-agent

## Summary
Rewrote `/home/z/my-project/src/app/api/stream/source/route.ts` to remove expensive server-side HEAD validation, reorder embed providers by reliability, and add last-resort IMDB ID fallback URLs.

## Changes Made

### Removed
- `isEmbedUrlAlive` function — 5s HEAD check per URL, added 5-15s total latency
- `fetchVidSrcToSources` function — server-side HTML extraction, unreliable with Cloudflare
- `fetchEgyBestSources` function and local `DownloadLink` type — unconfigured, added latency
- `extractSourcesFromHtml` function — only used by fetchVidSrcToSources
- Constants: `VIDSRC_TO_DOMAIN`, `EMBED_SU_DOMAIN`, `EGYBEST_API_BASE`, `EGYBEST_API_TOKEN`
- Builder functions: `buildVidSrcToEmbedUrl`, `buildEmbedSuUrl` (inlined)
- `vidapi.domains` from VIDAPI_EMBED_DOMAINS (less reliable)

### Added
- `buildImdbEmbedUrl` function — builds embed URLs using IMDB ID format (tt1234567)
- `fetchImdbId` function — fetches IMDB ID from TMDB external_ids API concurrently
- Last-resort IMDB ID fallback URLs appended to fallbackUrls array
- `providersChecked` field in response — count of embed providers available
- `quality` field in SourceResponse — "1080p" hint for client

### Modified
- Reordered embed providers by reliability: vidapi.ru → vaplayer.ru → embed.su → vidsrcme.ru → vidsrcme.su → vsrc.su → vidsrc.to
- Reduced vaplayer streamdata API timeout from 15s to 8s
- Simplified GET handler — all embed URLs returned in order, client cycles through them

## Verification
- ESLint: passes clean
- Dev server: compiles successfully, no errors in dev.log
