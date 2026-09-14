-- Adds the track column to an existing database.
--
-- schema.sql only creates tables that are not there, so a deployment that
-- predates tracks needs this one statement. It is safe to run once and will
-- error with "duplicate column name" if run twice, which is the harmless way
-- round.
--
--   wrangler d1 execute whooptimer-stats --file=./migrations/001-add-track.sql --remote
--
-- Existing rows get NULL, which is correct: nobody said where those were flown.

ALTER TABLE sessions ADD COLUMN track TEXT;
