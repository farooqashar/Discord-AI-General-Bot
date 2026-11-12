-- Small key/value table. Holds the last set of slash commands registered with
-- Discord, so the bot can re-register automatically after a deploy changes them.
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
