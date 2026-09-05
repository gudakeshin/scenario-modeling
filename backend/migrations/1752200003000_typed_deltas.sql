-- Up Migration

-- Typed parameter deltas: 'percent' (relative change) vs 'absolute' (set value).
-- Replaces the old implicit heuristic "value between 0 and 100 means percent",
-- which silently misread negative deltas (cost cuts) and >100% changes.
ALTER TABLE scenario_parameters
    ADD COLUMN IF NOT EXISTS delta_type VARCHAR(16) NOT NULL DEFAULT 'absolute';

ALTER TABLE scenario_parameters
    ADD CONSTRAINT scenario_parameters_delta_type_check
    CHECK (delta_type IN ('percent', 'absolute'));

-- Best-effort backfill: rows the old heuristic treated as percent deltas
-- (variable tagged percent_delta in the model, value in [0, 100]).
UPDATE scenario_parameters sp
SET delta_type = 'percent'
FROM scenarios s
JOIN user_models um ON um.model_id::text = s.model_version_hash
WHERE sp.scenario_id = s.scenario_id
  AND sp.scenario_value >= 0
  AND sp.scenario_value <= 100
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements(um.model_definition->'variables') v
    WHERE v->>'id' = sp.mapped_variable_id
      AND (v->'tags') ? 'percent_delta'
  );

-- Original uploaded file bytes, so XLSX models can be re-processed and
-- simulated at cell level (previously multer memoryStorage discarded them).
ALTER TABLE documents
    ADD COLUMN IF NOT EXISTS file_bytes BYTEA;

-- Persistent scenario working context (touched levers, constraints,
-- question history) — previously an in-memory Map lost on restart.
ALTER TABLE scenarios
    ADD COLUMN IF NOT EXISTS context_data JSONB;

-- Down Migration

ALTER TABLE scenarios DROP COLUMN IF EXISTS context_data;
ALTER TABLE documents DROP COLUMN IF EXISTS file_bytes;
ALTER TABLE scenario_parameters DROP CONSTRAINT IF EXISTS scenario_parameters_delta_type_check;
ALTER TABLE scenario_parameters DROP COLUMN IF EXISTS delta_type;
