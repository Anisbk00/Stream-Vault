/** A single subtitle cue (one line of text with start/end timing) */
export interface SubtitleCue {
  start: number; // seconds (decimal)
  end: number;   // seconds (decimal)
  text: string;
}

/** Available subtitle track from OpenSubtitles */
export interface SubtitleTrack {
  /** OpenSubtitles file ID */
  id: string;
  /** ISO 639-1 language code (e.g., "en", "fr", "ar") */
  language: string;
  /** Human-readable language name (e.g., "English") */
  languageName: string;
  /** Number of downloads (higher = better quality) */
  downloadCount: number;
  /** Release name hint */
  releaseName: string;
}
