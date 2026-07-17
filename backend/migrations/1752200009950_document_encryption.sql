ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS encryption_version VARCHAR(40);
