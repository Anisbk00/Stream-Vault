export interface ContentItem {
  id: string | number;
  title?: string;
  name?: string;
  original_title?: string;
  original_name?: string;
  overview?: string;
  poster_path?: string;
  backdrop_path?: string;
  release_date?: string;
  first_air_date?: string;
  vote_average?: number;
  vote_count?: number;
  popularity?: number;
  genre_ids?: number[];
  media_type?: 'movie' | 'tv';
  adult?: boolean;
  original_language?: string;
}

export interface ContentDetail extends ContentItem {
  genres?: Genre[];
  runtime?: number;
  number_of_seasons?: number;
  number_of_episodes?: number;
  status?: string;
  tagline?: string;
  production_companies?: { id: number; name: string; logo_path?: string }[];
  credits?: {
    cast?: CastMember[];
    crew?: CrewMember[];
  };
  similar?: { results: ContentItem[] };
  videos?: { results: Video[] };
  seasons?: Season[];
}

export interface Genre {
  id: number;
  name: string;
}

export interface CastMember {
  id: number;
  name: string;
  character: string;
  profile_path?: string;
  order: number;
}

export interface CrewMember {
  id: number;
  name: string;
  job: string;
  department: string;
  profile_path?: string;
}

export interface Video {
  id: string;
  key: string;
  name: string;
  site: string;
  type: string;
  official: boolean;
}

export interface Season {
  id: number;
  name: string;
  season_number: number;
  episode_count: number;
  air_date?: string;
  overview?: string;
  poster_path?: string;
}

export interface EpisodeDetail {
  id: number;
  name: string;
  overview: string;
  episode_number: number;
  season_number: number;
  still_path?: string;
  air_date?: string;
  runtime?: number;
  vote_average?: number;
}

export interface StreamSource {
  url: string;
  quality: string;
  type: 'hls' | 'mp4';
  /** Which provider returned this source (vidapi, vidsrc-to, egybest, etc.) */
  provider?: string;
}

export interface DownloadLink {
  url: string;
  streamUrl?: string;
  quality: string;
  resolution: string;
  fileSize?: string;
  fileName?: string;
  provider: string;
}

export interface WatchProgress {
  contentId: string | number;
  mediaType?: 'movie' | 'tv';
  season?: number;
  episode?: number;
  progress: number;
  duration: number;
  updatedAt: number;
}

export type NavigationPage = 'home' | 'browse' | 'search' | 'detail' | 'watch' | 'downloads' | 'mylist' | 'profile';

export interface SearchFilters {
  query: string;
  genre?: number;
  year?: string;
  sortBy?: 'popularity' | 'rating' | 'release_date' | 'title';
  type?: 'movie' | 'tv' | 'all';
}
