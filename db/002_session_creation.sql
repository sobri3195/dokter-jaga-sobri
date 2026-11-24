ALTER TABLE sessions ADD COLUMN IF NOT EXISTS creation_id uuid;

CREATE UNIQUE INDEX IF NOT EXISTS sessions_guest_creation
  ON sessions (guest_id, creation_id) WHERE creation_id IS NOT NULL;
