CREATE TABLE IF NOT EXISTS cases (
  id text PRIMARY KEY
);
CREATE TABLE IF NOT EXISTS case_versions (
  case_id text NOT NULL REFERENCES cases,
  version integer NOT NULL,
  definition jsonb NOT NULL,
  PRIMARY KEY (case_id, version)
);
CREATE TABLE IF NOT EXISTS guests (
  id uuid PRIMARY KEY
);
CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY,
  guest_id uuid NOT NULL REFERENCES guests,
  case_id text NOT NULL,
  version integer NOT NULL,
  revision integer NOT NULL DEFAULT 0,
  snapshot jsonb NOT NULL,
  finished boolean NOT NULL DEFAULT false,
  created timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (case_id, version) REFERENCES case_versions
);
CREATE INDEX IF NOT EXISTS sessions_guest_created ON sessions (guest_id, created DESC);
CREATE TABLE IF NOT EXISTS session_events (
  session_id uuid NOT NULL REFERENCES sessions,
  seq integer NOT NULL,
  event jsonb NOT NULL,
  PRIMARY KEY (session_id, seq)
);
CREATE TABLE IF NOT EXISTS session_commands (
  session_id uuid NOT NULL REFERENCES sessions,
  command_id uuid NOT NULL,
  fingerprint text NOT NULL,
  response jsonb NOT NULL,
  PRIMARY KEY (session_id, command_id)
);
CREATE TABLE IF NOT EXISTS session_debriefs (
  session_id uuid PRIMARY KEY REFERENCES sessions,
  result jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS rate_limits (
  guest_id uuid NOT NULL REFERENCES guests,
  bucket bigint NOT NULL,
  kind text NOT NULL,
  count integer NOT NULL,
  PRIMARY KEY (guest_id, kind, bucket)
);
