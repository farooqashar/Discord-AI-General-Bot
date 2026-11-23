-- When each website session was last confirmed, by Discord, to still be in
-- each server, and when asking Discord last failed. The bot also creates this
-- table on first use, so applying this is optional.
CREATE TABLE IF NOT EXISTS web_session_checks (
  token TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  verified_at INTEGER NOT NULL DEFAULT 0, -- ms
  failed_at INTEGER, -- ms
  PRIMARY KEY (token, guild_id)
);
