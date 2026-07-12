-- Wave 5/6: scenario versions, organizations, actuals, object storage pointers

-- Persisted scenario version snapshots (replaces in-memory comparisonVersions)
CREATE TABLE IF NOT EXISTS scenario_versions (
    version_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scenario_id UUID NOT NULL REFERENCES scenarios(scenario_id) ON DELETE CASCADE,
    workspace_id UUID REFERENCES workspaces(workspace_id) ON DELETE SET NULL,
    label VARCHAR(255) NOT NULL,
    version_number INTEGER NOT NULL DEFAULT 1,
    touched_levers JSONB NOT NULL DEFAULT '[]'::jsonb,
    parameters_snapshot JSONB NOT NULL DEFAULT '[]'::jsonb,
    outputs JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_by UUID REFERENCES users(user_id),
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE (scenario_id, version_number)
);

CREATE INDEX IF NOT EXISTS idx_scenario_versions_scenario
    ON scenario_versions(scenario_id, version_number DESC);

-- Organizations (multi-tenant above workspaces)
CREATE TABLE IF NOT EXISTS organizations (
    organization_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    slug VARCHAR(100) UNIQUE,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS organization_members (
    membership_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(organization_id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    org_role VARCHAR(50) NOT NULL DEFAULT 'member', -- owner | admin | member
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE (organization_id, user_id)
);

ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(organization_id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_workspaces_organization
    ON workspaces(organization_id) WHERE organization_id IS NOT NULL;

-- Actuals / budget / forecast lane
CREATE TABLE IF NOT EXISTS actuals_facts (
    fact_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
    source_kind VARCHAR(40) NOT NULL DEFAULT 'upload'
        CHECK (source_kind IN ('upload', 'sac', 'anaplan', 'manual')),
    measure_id TEXT NOT NULL,
    period TEXT NOT NULL,
    version_lane VARCHAR(40) NOT NULL DEFAULT 'actual'
        CHECK (version_lane IN ('actual', 'budget', 'forecast')),
    entity_key TEXT,
    value NUMERIC NOT NULL,
    currency VARCHAR(16),
    unit VARCHAR(32),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_actuals_facts_workspace
    ON actuals_facts(workspace_id, version_lane, period);

-- Object storage pointer for original workbook bytes
ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS storage_key TEXT,
  ADD COLUMN IF NOT EXISTS storage_backend VARCHAR(20) DEFAULT 'postgres';

-- llm_usage cache token columns (Wave 4 prompt caching)
ALTER TABLE llm_usage
  ADD COLUMN IF NOT EXISTS cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0;
