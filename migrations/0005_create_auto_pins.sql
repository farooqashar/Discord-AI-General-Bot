-- Channels where the bot pins matching messages once a day (/auto-pin).
-- The bot also creates this table on first use, so applying this is optional.
CREATE TABLE IF NOT EXISTS auto_pins (
  channel_id TEXT PRIMARY KEY,
  guild_id TEXT,
  rule TEXT NOT NULL,
  hour INTEGER NOT NULL,
  minute INTEGER NOT NULL,
  report_channel_id TEXT,
  last_sent TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
