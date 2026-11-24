ALTER TABLE case_versions ADD COLUMN engine_version integer NOT NULL DEFAULT 1 CHECK (engine_version > 0);
CREATE FUNCTION reject_case_version_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Published case versions are immutable' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER case_versions_immutable BEFORE UPDATE OR DELETE ON case_versions
  FOR EACH ROW EXECUTE FUNCTION reject_case_version_change();

ALTER TABLE guests ADD COLUMN last_seen_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE sessions ADD COLUMN last_activity_at timestamptz;
UPDATE sessions SET last_activity_at = greatest(created, now());
ALTER TABLE sessions ALTER COLUMN last_activity_at SET DEFAULT now(), ALTER COLUMN last_activity_at SET NOT NULL;
CREATE INDEX guests_expiry ON guests (last_seen_at);
CREATE INDEX sessions_expiry ON sessions (last_activity_at);
CREATE INDEX rate_limits_expiry ON rate_limits (bucket);

ALTER TABLE session_events DROP CONSTRAINT session_events_session_id_fkey,
  ADD FOREIGN KEY (session_id) REFERENCES sessions ON DELETE CASCADE;
ALTER TABLE session_commands DROP CONSTRAINT session_commands_session_id_fkey,
  ADD FOREIGN KEY (session_id) REFERENCES sessions ON DELETE CASCADE;
ALTER TABLE session_debriefs DROP CONSTRAINT session_debriefs_session_id_fkey,
  ADD FOREIGN KEY (session_id) REFERENCES sessions ON DELETE CASCADE;
ALTER TABLE rate_limits DROP CONSTRAINT rate_limits_guest_id_fkey,
  ADD FOREIGN KEY (guest_id) REFERENCES guests ON DELETE CASCADE;

CREATE TABLE guest_admissions (
  bucket bigint NOT NULL,
  source_hash text NOT NULL,
  count integer NOT NULL,
  PRIMARY KEY (bucket, source_hash)
);
