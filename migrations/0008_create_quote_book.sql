-- The Quote Book and its website sessions. The bot also creates these tables
-- on first use, so applying this is optional.
CREATE TABLE IF NOT EXISTS quote_books (
  guild_id TEXT PRIMARY KEY,
  guild_name TEXT,
  channel_id TEXT NOT NULL,
  last_message_id TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS quotes (
  message_id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  text TEXT NOT NULL,
  speaker TEXT,
  speaker_id TEXT,
  poster_id TEXT,
  poster_name TEXT,
  posted_at INTEGER NOT NULL, -- ms
  stars INTEGER NOT NULL DEFAULT 0,
  reactions INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_quotes_guild ON quotes (guild_id, posted_at);

-- "Sign in with Discord" sessions: who, which servers they're in, until when.
CREATE TABLE IF NOT EXISTS web_sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  username TEXT,
  guild_ids TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
