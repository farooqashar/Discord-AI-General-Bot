-- Adjustable daily pin limit for /auto-pin (NULL means the default of 5).
-- The bot also adds this column on first use, so applying this is optional.
ALTER TABLE auto_pins ADD COLUMN max_pins INTEGER;
