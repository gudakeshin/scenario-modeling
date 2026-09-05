-- Async ingestion lifecycle and progress reporting.
ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS progress INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS processing_error TEXT,
  ADD COLUMN IF NOT EXISTS queued_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS processing_completed_at TIMESTAMPTZ;

ALTER TABLE documents
  DROP CONSTRAINT IF EXISTS documents_progress_check;
ALTER TABLE documents
  ADD CONSTRAINT documents_progress_check CHECK (progress BETWEEN 0 AND 100);

CREATE INDEX IF NOT EXISTS idx_documents_workspace_created
  ON documents(workspace_id, created_at DESC);
