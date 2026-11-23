-- When each website session was last confirmed, by Discord, to still be in
-- each server. The bot also creates this table on first use, so applying this
-- is optional.
CREATE TABLE IF NOT EXISTS web_session_checks (
  token TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  verified_at INTEGER NOT NULL, -- ms
  PRIMARY KEY (token, guild_id)
);
