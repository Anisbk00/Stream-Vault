# Task 1-3: Settings UI Agent

## Task
Add useSettingsStore + subtitle/download settings UI

## Work Done
1. **store/index.ts** — Appended `useSettingsStore` with `preferredSubtitles`, `downloadFolderName`, `togglePreferredSubtitle`, `isSubtitlePreferred` actions. Uses `persist` middleware with `streamvault-settings` key.

2. **download-storage.ts** — Cleaned up duplicate directory handle functions from a previous agent (4-5). Consolidated to single implementations: `saveDirectoryHandle`, `loadDirectoryHandle`, `removeDirectoryHandle` using key `dir-handle:download-folder`.

3. **ProfileCompletionScreen.tsx** — Added:
   - Import: `useSettingsStore`
   - Constant: `SUBTITLE_LANGUAGES` (18 languages)
   - Store access: `preferredSubtitles`, `togglePreferredSubtitle`
   - JSX: Subtitle language chip selector between name input and submit button

4. **ProfilePage.tsx** — Added:
   - Imports: `useSettingsStore`, `FolderOpen`, `Subtitles` from lucide-react
   - Constant: `SUBTITLE_LANGUAGES` (same 18 languages)
   - Store access: `preferredSubtitles`, `togglePreferredSubtitle`, `downloadFolderName`, `setDownloadFolderName`
   - State: `isEditingSubtitles`, `isPickingFolder`
   - Handler: `handleChooseDownloadFolder` (File System Access API with permission checks)
   - Two new sections: "Offline Subtitles" (expandable chip selector) and "Downloads" (folder picker + reset)
   - Sections placed between Account and Admin Hub

## Lint
Passed cleanly with no errors.
