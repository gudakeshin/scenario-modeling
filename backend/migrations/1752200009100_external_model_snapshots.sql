-- Up Migration

CREATE TABLE IF NOT EXISTS external_model_snapshots (
    snapshot_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    connection_id UUID NOT NULL REFERENCES planning_connections(connection_id),
    workspace_id UUID NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
    provider VARCHAR(30) NOT NULL,
    external_model_id TEXT NOT NULL,
    external_model_name TEXT NOT NULL,
    snapshot_version INTEGER NOT NULL DEFAULT 1,
    status VARCHAR(20) NOT NULL DEFAULT 'importing'
        CHECK (status IN ('importing', 'ready', 'failed', 'superseded')),
    error TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    stats JSONB NOT NULL DEFAULT '{}'::jsonb,
    fact_query JSONB,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_external_model_snapshots_version
    ON external_model_snapshots(connection_id, external_model_id, snapshot_version);

CREATE INDEX IF NOT EXISTS idx_external_model_snapshots_workspace
    ON external_model_snapshots(workspace_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_external_model_snapshots_connection
    ON external_model_snapshots(connection_id, status);

CREATE TABLE IF NOT EXISTS external_model_facts (
    snapshot_id UUID NOT NULL REFERENCES external_model_snapshots(snapshot_id) ON DELETE CASCADE,
    measure_id TEXT NOT NULL,
    member_key TEXT NOT NULL,
    value NUMERIC NOT NULL,
    PRIMARY KEY (snapshot_id, measure_id, member_key)
);

CREATE INDEX IF NOT EXISTS idx_external_model_facts_snapshot
    ON external_model_facts(snapshot_id);

ALTER TABLE user_models
    ADD COLUMN IF NOT EXISTS source_kind VARCHAR(30) NOT NULL DEFAULT 'documents';

ALTER TABLE user_models
    ADD COLUMN IF NOT EXISTS snapshot_id UUID REFERENCES external_model_snapshots(snapshot_id);

CREATE INDEX IF NOT EXISTS idx_user_models_snapshot
    ON user_models(snapshot_id)
    WHERE snapshot_id IS NOT NULL;

-- Down Migration

DROP INDEX IF EXISTS idx_user_models_snapshot;
ALTER TABLE user_models DROP COLUMN IF EXISTS snapshot_id;
ALTER TABLE user_models DROP COLUMN IF EXISTS source_kind;
DROP INDEX IF EXISTS idx_external_model_facts_snapshot;
DROP TABLE IF EXISTS external_model_facts;
DROP INDEX IF EXISTS idx_external_model_snapshots_connection;
DROP INDEX IF EXISTS idx_external_model_snapshots_workspace;
DROP INDEX IF EXISTS uq_external_model_snapshots_version;
DROP TABLE IF EXISTS external_model_snapshots;
