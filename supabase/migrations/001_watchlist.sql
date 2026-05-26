-- Watchlist table: per-user, stores full content item as JSONB
CREATE TABLE IF NOT EXISTS public.watchlist (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  content_id TEXT NOT NULL,
  media_type TEXT NOT NULL DEFAULT 'movie',
  item_data JSONB NOT NULL,
  added_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, content_id)
);

-- Enable RLS
ALTER TABLE public.watchlist ENABLE ROW LEVEL SECURITY;

-- Anyone authenticated can read watchlist entries
CREATE POLICY "Authenticated users can read watchlist" ON public.watchlist
  FOR SELECT TO authenticated
  USING (true);

-- Users can insert their own watchlist items
CREATE POLICY "Users can insert own watchlist" ON public.watchlist
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

-- Users can update their own watchlist items
CREATE POLICY "Users can update own watchlist" ON public.watchlist
  FOR UPDATE TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Users can delete their own watchlist items
CREATE POLICY "Users can delete own watchlist" ON public.watchlist
  FOR DELETE TO authenticated
  USING (auth.uid() = user_id);
