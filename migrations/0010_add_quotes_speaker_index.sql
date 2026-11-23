-- Lets the Quote Book find the name a mentioned speaker has on their other
-- quotes. The bot also creates this index on first use, so applying this is
-- optional.
CREATE INDEX IF NOT EXISTS idx_quotes_speaker ON quotes (guild_id, speaker_id);
