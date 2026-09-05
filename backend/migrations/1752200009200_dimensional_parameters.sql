-- Up Migration

ALTER TABLE scenario_parameters
    ADD COLUMN IF NOT EXISTS member_scope JSONB;

-- Down Migration

ALTER TABLE scenario_parameters
    DROP COLUMN IF EXISTS member_scope;
