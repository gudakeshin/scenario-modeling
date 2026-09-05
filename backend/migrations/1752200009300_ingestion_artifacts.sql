-- Formula-preserving ingestion artifacts
-- Separates sparse workbook snapshots from graph metadata; adds CSV tabular
-- artifacts and structured ingestion reports.

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS artifact_version INTEGER DEFAULT 1;

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS ingestion_report JSONB;

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS tabular_artifact JSONB;

-- Sparse formula-preserving cell snapshot (separate from workbook_graph metadata)
ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS workbook_snapshot JSONB;

-- Allow tabular_data kind alongside spreadsheet_model / document_text
COMMENT ON COLUMN documents.document_kind IS
  'spreadsheet_model | tabular_data | document_text';
