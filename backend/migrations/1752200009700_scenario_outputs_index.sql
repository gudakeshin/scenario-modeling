-- Up Migration

CREATE INDEX IF NOT EXISTS idx_scenario_outputs_scenario_created
  ON scenario_outputs (scenario_id, created_at DESC);

-- Down Migration

DROP INDEX IF EXISTS idx_scenario_outputs_scenario_created;
