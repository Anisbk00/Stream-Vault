# Task 2-a: Watch Party Player UX Improvements

## Summary
Completed all 8 changes to VideoPlayer.tsx and StreamVaultApp.tsx for watch party fullscreen lock, speaking indicators, and member list support.

## Changes Made

### VideoPlayer.tsx
1. **WatchPartySync interface** — Added `members` and `localUserId` fields
2. **IframeEmbedPlayer fullscreen button** — Wrapped with `(!watchPartySync || watchPartySync.isHost)` condition; removed "Host controls playback" span
3. **IframeEmbedPlayer PTT button** — Added `members` and `localUserId` props
4. **IframeEmbedPlayer** — Added `FullscreenSpeakingIndicator` overlay after PTT button
5. **HlsVideoPlayer fullscreen button** — Wrapped with same host-only condition
6. **HlsVideoPlayer PTT button** — Added `members` and `localUserId` props
7. **HlsVideoPlayer** — Added `FullscreenSpeakingIndicator` overlay after PTT button
8. **FullscreenSpeakingIndicator component** — New component showing speaking users with names + mic icon on right side during fullscreen
9. **getSpeakingNames helper** — Builds display names from talkingMembers Set
10. **WatchPartyPttButton** — Updated props interface and speaking indicator to show "You" or specific user names

### StreamVaultApp.tsx
11. **watchPartySync object** — Added `members` (mapped from currentParty.members) and `localUserId` (from useAuthStore)

## Verification
- Lint: 0 errors, 1 pre-existing warning (unrelated)
- Dev server: running cleanly on port 3000
