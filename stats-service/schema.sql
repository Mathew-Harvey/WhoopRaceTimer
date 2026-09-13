-- The whole database. Two tables, no accounts, no email addresses, and nothing
-- about a pilot that they did not type in themselves.
--
--   wrangler d1 execute whooptimer-stats --file=./schema.sql --remote

CREATE TABLE IF NOT EXISTS pilots (
  id           TEXT PRIMARY KEY,     -- the uuid the browser generated
  name         TEXT NOT NULL,        -- the display name, as typed
  -- SHA-256 of the secret the browser holds. The secret itself is never sent
  -- anywhere but in a request body and never stored: this row cannot be used
  -- to impersonate the pilot it describes.
  secret_hash  TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  -- Denormalised so the leaderboard is one query rather than one aggregation
  -- per pilot. Recomputed from the sessions on every write.
  best_lap     REAL,
  best_consec  REAL,
  laps_clean   INTEGER NOT NULL DEFAULT 0,
  sessions_n   INTEGER NOT NULL DEFAULT 0,
  air_time_s   REAL NOT NULL DEFAULT 0,
  last_at      INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  pilot_id   TEXT NOT NULL,
  run_id     TEXT NOT NULL,          -- the app's own id for one race
  at         INTEGER NOT NULL,       -- epoch seconds, when it was flown
  mode       TEXT,
  consec_n   INTEGER,
  min_lap    REAL,
  holeshot   INTEGER,
  duration   REAL,
  channel    TEXT,
  pos        INTEGER,
  lap_times  TEXT NOT NULL,          -- JSON array of seconds, in the order flown
  created_at INTEGER NOT NULL,
  PRIMARY KEY (pilot_id, run_id),
  FOREIGN KEY (pilot_id) REFERENCES pilots(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS sessions_pilot_at ON sessions(pilot_id, at);
CREATE INDEX IF NOT EXISTS pilots_best ON pilots(best_lap);
