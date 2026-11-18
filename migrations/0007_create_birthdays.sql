-- /birthday. The bot also creates these tables on first use, so applying this
-- is optional. Only the month and day are stored, never the year.
CREATE TABLE IF NOT EXISTS birthdays (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  name TEXT,
  month INTEGER NOT NULL,
  day INTEGER NOT NULL,
  added_by TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE IF NOT EXISTS birthday_settings (
  guild_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  hour INTEGER NOT NULL,
  minute INTEGER NOT NULL,
  last_sent TEXT
);
