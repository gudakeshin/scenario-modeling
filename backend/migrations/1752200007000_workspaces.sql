-- Up Migration

CREATE TABLE IF NOT EXISTS workspaces (
    workspace_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    is_default BOOLEAN NOT NULL DEFAULT FALSE,
    status VARCHAR(20) NOT NULL DEFAULT 'active', -- active | deleted
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workspaces_owner ON workspaces(owner_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_workspaces_owner_default
    ON workspaces(owner_id) WHERE is_default AND status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS uq_workspaces_owner_name
    ON workspaces(owner_id, lower(name)) WHERE status = 'active';

-- Nullable during rollout; hardened to NOT NULL in a later migration once
-- backfill has run. No ON DELETE CASCADE: workspace deletion is handled in
-- workspaceService (documents hard-deleted, scenarios archived — audit_trail
-- rows are immutable and block scenario hard deletes).
ALTER TABLE documents       ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES workspaces(workspace_id);
ALTER TABLE company_context ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES workspaces(workspace_id);
ALTER TABLE user_models     ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES workspaces(workspace_id);
ALTER TABLE scenarios       ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES workspaces(workspace_id);

-- Down Migration

ALTER TABLE scenarios       DROP COLUMN IF EXISTS workspace_id;
ALTER TABLE user_models     DROP COLUMN IF EXISTS workspace_id;
ALTER TABLE company_context DROP COLUMN IF EXISTS workspace_id;
ALTER TABLE documents       DROP COLUMN IF EXISTS workspace_id;
DROP INDEX IF EXISTS uq_workspaces_owner_name;
DROP INDEX IF EXISTS uq_workspaces_owner_default;
DROP INDEX IF EXISTS idx_workspaces_owner;
DROP TABLE IF EXISTS workspaces;
