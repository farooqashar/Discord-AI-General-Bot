-- Scheduled posts. The bot also creates these tables on first use, so
-- applying this is optional.
CREATE TABLE IF NOT EXISTS digests (
  channel_id TEXT PRIMARY KEY,
  guild_id TEXT,
  topics TEXT NOT NULL,
  hour INTEGER NOT NULL,
  minute INTEGER NOT NULL,
  last_sent TEXT, -- local date (YYYY-MM-DD) of the last post
  created_by TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS wrapped (
  channel_id TEXT PRIMARY KEY, -- where the recap is posted
  guild_id TEXT NOT NULL,
  about_channel_id TEXT, -- NULL = the whole server
  frequency TEXT NOT NULL, -- weekly | monthly
  weekday INTEGER, -- 0 = Sunday
  hour INTEGER NOT NULL,
  minute INTEGER NOT NULL,
  last_sent TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
