/**
 * StreamVault — Supabase database types.
 *
 * Auto-generated from schema. Update after running:
 *   supabase gen types typescript --linked
 *
 * For now, hand-written to match 001_streamvault_schema.sql.
 */

export interface Database {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string;
          email: string;
          display_name: string;
          avatar_url: string | null;
          role: 'vip' | 'admin';
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id: string;
          email: string;
          display_name?: string;
          avatar_url?: string | null;
          role?: 'vip' | 'admin';
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          email?: string;
          display_name?: string;
          avatar_url?: string | null;
          role?: 'vip' | 'admin';
          updated_at?: string;
        };
        Relationships: [];
      };
      watchlist: {
        Row: {
          id: number;
          user_id: string;
          content_id: string;
          media_type: string;
          item_data: Record<string, unknown>;
          added_at: string;
        };
        Insert: {
          id?: number;
          user_id: string;
          content_id: string;
          media_type?: string;
          item_data: Record<string, unknown>;
          added_at?: string;
        };
        Update: {
          id?: number;
          user_id?: string;
          content_id?: string;
          media_type?: string;
          item_data?: Record<string, unknown>;
          added_at?: string;
        };
        Relationships: [];
      };
      user_sessions: {
        Row: {
          id: number;
          user_id: string;
          session_id: string;
          device_info: string;
          ip_address: string | null;
          last_active: string;
          created_at: string;
        };
        Insert: {
          id?: number;
          user_id: string;
          session_id: string;
          device_info?: string;
          ip_address?: string | null;
          last_active?: string;
          created_at?: string;
        };
        Update: {
          id?: number;
          user_id?: string;
          session_id?: string;
          device_info?: string;
          ip_address?: string | null;
          last_active?: string;
          created_at?: string;
        };
        Relationships: [];
      };
      watch_parties: {
        Row: {
          id: string;
          host_id: string;
          content_id: string | null;
          media_type: string | null;
          season: number | null;
          episode: number | null;
          content_title: string | null;
          content_poster: string | null;
          status: 'waiting' | 'playing' | 'ended';
          playback_time: number;
          is_playing: boolean;
          paused_by: string | null;
          created_at: string;
          ended_at: string | null;
        };
        Insert: {
          id?: string;
          host_id: string;
          content_id?: string | null;
          media_type?: string | null;
          season?: number | null;
          episode?: number | null;
          content_title?: string | null;
          content_poster?: string | null;
          status?: 'waiting' | 'playing' | 'ended';
          playback_time?: number;
          is_playing?: boolean;
          paused_by?: string | null;
          created_at?: string;
          ended_at?: string | null;
        };
        Update: {
          id?: string;
          host_id?: string;
          content_id?: string | null;
          media_type?: string | null;
          season?: number | null;
          episode?: number | null;
          content_title?: string | null;
          content_poster?: string | null;
          status?: 'waiting' | 'playing' | 'ended';
          playback_time?: number;
          is_playing?: boolean;
          paused_by?: string | null;
          created_at?: string;
          ended_at?: string | null;
        };
        Relationships: [];
      };
      watch_party_members: {
        Row: {
          id: string;
          party_id: string;
          user_id: string;
          status: 'invited' | 'joined' | 'left' | 'rejected';
          joined_at: string | null;
        };
        Insert: {
          id?: string;
          party_id: string;
          user_id: string;
          status?: 'invited' | 'joined' | 'left' | 'rejected';
          joined_at?: string | null;
        };
        Update: {
          id?: string;
          party_id?: string;
          user_id?: string;
          status?: 'invited' | 'joined' | 'left' | 'rejected';
          joined_at?: string | null;
        };
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
      get_my_profile: {
        Args: Record<string, never>;
        Returns: {
          id: string;
          email: string;
          display_name: string;
          avatar_url: string | null;
          role: 'vip' | 'admin';
          created_at: string;
          updated_at: string;
          is_complete: boolean;
        }[];
      };
    };
    Enums: Record<string, never>;
  };
}

export type Tables = Database['public']['Tables'];
export type ProfilesInsert = Tables['profiles']['Insert'];
export type ProfilesUpdate = Tables['profiles']['Update'];
export type ProfilesRow = Tables['profiles']['Row'];
export type WatchPartyRow = Tables['watch_parties']['Row'];
export type WatchPartyMemberRow = Tables['watch_party_members']['Row'];
