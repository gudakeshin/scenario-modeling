-- Up Migration

-- 1. Create a Default workspace for every existing user that lacks one.
INSERT INTO workspaces (owner_id, name, is_default)
SELECT u.user_id, 'Default', TRUE
FROM users u
WHERE NOT EXISTS (
    SELECT 1 FROM workspaces w
    WHERE w.owner_id = u.user_id AND w.is_default AND w.status = 'active'
);

-- 2. Assign existing rows to their owner's default workspace (idempotent).
UPDATE documents d SET workspace_id = w.workspace_id
FROM workspaces w
WHERE w.owner_id = d.created_by AND w.is_default AND w.status = 'active'
  AND d.workspace_id IS NULL;

UPDATE company_context c SET workspace_id = w.workspace_id
FROM workspaces w
WHERE w.owner_id = c.created_by AND w.is_default AND w.status = 'active'
  AND c.workspace_id IS NULL;

UPDATE user_models m SET workspace_id = w.workspace_id
FROM workspaces w
WHERE w.owner_id = m.created_by AND w.is_default AND w.status = 'active'
  AND m.workspace_id IS NULL;

UPDATE scenarios s SET workspace_id = w.workspace_id
FROM workspaces w
WHERE w.owner_id = s.creator_id AND w.is_default AND w.status = 'active'
  AND s.workspace_id IS NULL;

-- 3. Dedupe actives (keep newest per workspace) so the partial unique
--    indexes below can be created even if legacy data has duplicates.
UPDATE company_context c SET status = 'superseded'
WHERE c.status = 'active' AND c.workspace_id IS NOT NULL
  AND c.context_id NOT IN (
    SELECT DISTINCT ON (workspace_id) context_id FROM company_context
    WHERE status = 'active' AND workspace_id IS NOT NULL
    ORDER BY workspace_id, created_at DESC
  );

UPDATE user_models m SET is_active = FALSE
WHERE m.is_active AND m.workspace_id IS NOT NULL
  AND m.model_id NOT IN (
    SELECT DISTINCT ON (workspace_id) model_id FROM user_models
    WHERE is_active AND workspace_id IS NOT NULL
    ORDER BY workspace_id, created_at DESC
  );

-- 4. Single-active-per-workspace constraints (replaces per-user convention).
CREATE UNIQUE INDEX IF NOT EXISTS uq_company_context_active_ws
    ON company_context(workspace_id) WHERE status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS uq_user_models_active_ws
    ON user_models(workspace_id) WHERE is_active;

-- 5. Query-path indexes.
CREATE INDEX IF NOT EXISTS idx_documents_workspace
    ON documents(workspace_id, status, document_kind, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_scenarios_workspace
    ON scenarios(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_company_context_workspace
    ON company_context(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_user_models_workspace
    ON user_models(workspace_id, is_active);

-- Down Migration

-- Data changes (backfill/dedupe) are not reversed; only the indexes are.
DROP INDEX IF EXISTS idx_user_models_workspace;
DROP INDEX IF EXISTS idx_company_context_workspace;
DROP INDEX IF EXISTS idx_scenarios_workspace;
DROP INDEX IF EXISTS idx_documents_workspace;
DROP INDEX IF EXISTS uq_user_models_active_ws;
DROP INDEX IF EXISTS uq_company_context_active_ws;
