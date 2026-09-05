-- Minimum credible UPSI / SEBI PIT governance controls.
ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS sensitivity VARCHAR(20) NOT NULL DEFAULT 'confidential',
  ADD COLUMN IF NOT EXISTS nature_of_upsi TEXT;

ALTER TABLE workspaces DROP CONSTRAINT IF EXISTS workspaces_sensitivity_check;
ALTER TABLE workspaces
  ADD CONSTRAINT workspaces_sensitivity_check
  CHECK (sensitivity IN ('public', 'confidential', 'upsi'));

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_designated_person BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS workspace_memberships (
  workspace_id UUID NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  granted_by UUID REFERENCES users(user_id),
  access_reason TEXT NOT NULL DEFAULT 'Workspace owner',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, user_id)
);

INSERT INTO workspace_memberships (workspace_id, user_id, granted_by, access_reason)
SELECT workspace_id, owner_id, owner_id, 'Workspace owner'
FROM workspaces
ON CONFLICT (workspace_id, user_id) DO NOTHING;

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS trading_window_status VARCHAR(10) NOT NULL DEFAULT 'open',
  ADD COLUMN IF NOT EXISTS trading_window_from DATE,
  ADD COLUMN IF NOT EXISTS trading_window_until DATE,
  ADD COLUMN IF NOT EXISTS trading_window_note TEXT;

ALTER TABLE organizations DROP CONSTRAINT IF EXISTS organizations_trading_window_check;
ALTER TABLE organizations
  ADD CONSTRAINT organizations_trading_window_check
  CHECK (trading_window_status IN ('open', 'closed'));

CREATE TABLE IF NOT EXISTS upsi_access_log (
  access_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(workspace_id),
  user_id UUID NOT NULL REFERENCES users(user_id),
  artifact_type VARCHAR(40) NOT NULL,
  artifact_id TEXT NOT NULL,
  action VARCHAR(40) NOT NULL DEFAULT 'read',
  nature_of_upsi TEXT NOT NULL,
  accessed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  prev_hash CHAR(64) NOT NULL,
  row_hash CHAR(64) NOT NULL UNIQUE
);

CREATE INDEX IF NOT EXISTS idx_upsi_access_workspace_time
  ON upsi_access_log(workspace_id, accessed_at DESC);

CREATE TABLE IF NOT EXISTS upsi_access_chain_head (
  workspace_id UUID PRIMARY KEY REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  head_hash CHAR(64) NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION upsi_access_log_immutable()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'upsi_access_log is immutable';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_upsi_access_log_immutable ON upsi_access_log;
CREATE TRIGGER trg_upsi_access_log_immutable
BEFORE UPDATE OR DELETE ON upsi_access_log
FOR EACH ROW EXECUTE FUNCTION upsi_access_log_immutable();
