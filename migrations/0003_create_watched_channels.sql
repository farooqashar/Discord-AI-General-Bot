-- Channels where the bot answers @mentions (turned on with /listen).
-- The bot also creates this table on first use, so applying this is optional.
CREATE TABLE IF NOT EXISTS watched_channels (
  channel_id TEXT PRIMARY KEY,
  guild_id TEXT,
  last_seen_id TEXT, -- newest message already checked
  added_by TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
