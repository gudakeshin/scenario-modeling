-- Immutable, hash-chained provenance record written atomically with each P&L run.

CREATE TABLE IF NOT EXISTS run_manifests (
    manifest_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id UUID NOT NULL UNIQUE REFERENCES scenario_outputs(output_id) ON DELETE RESTRICT,
    scenario_id UUID NOT NULL REFERENCES scenarios(scenario_id) ON DELETE RESTRICT,
    scenario_version_id UUID NOT NULL REFERENCES scenario_versions(version_id) ON DELETE RESTRICT,
    workspace_id UUID REFERENCES workspaces(workspace_id) ON DELETE RESTRICT,
    model_document_id UUID REFERENCES documents(document_id) ON DELETE RESTRICT,
    model_hash TEXT NOT NULL,
    engine JSONB NOT NULL,
    levers JSONB NOT NULL,
    denomination JSONB NOT NULL,
    mc JSONB,
    created_by UUID NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    prev_hash TEXT NOT NULL DEFAULT '',
    row_hash TEXT NOT NULL UNIQUE
);

CREATE INDEX IF NOT EXISTS idx_run_manifests_scenario
    ON run_manifests(scenario_id, created_at DESC);

CREATE TABLE IF NOT EXISTS run_manifest_chain_head (
    id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    last_hash TEXT,
    last_manifest_id UUID
);

INSERT INTO run_manifest_chain_head (id, last_hash, last_manifest_id)
VALUES (1, NULL, NULL)
ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION run_manifests_immutable()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'run_manifests is immutable';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS run_manifests_no_mutate ON run_manifests;
CREATE TRIGGER run_manifests_no_mutate
    BEFORE UPDATE OR DELETE ON run_manifests
    FOR EACH ROW
    EXECUTE FUNCTION run_manifests_immutable();
