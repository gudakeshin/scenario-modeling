-- Up Migration

CREATE TABLE IF NOT EXISTS planning_connections (
    connection_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
    created_by UUID NOT NULL REFERENCES users(user_id),
    provider VARCHAR(30) NOT NULL CHECK (provider IN ('sap_sac', 'anaplan', 'oracle_pbcs', 'mock')),
    name TEXT NOT NULL,
    base_url TEXT NOT NULL,
    auth_kind VARCHAR(40) NOT NULL CHECK (auth_kind IN ('oauth2_client_credentials', 'api_key')),
    auth_public JSONB NOT NULL DEFAULT '{}'::jsonb,
    secret_ciphertext TEXT NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
    last_test_at TIMESTAMP,
    last_test_ok BOOLEAN,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_planning_connections_ws_name
    ON planning_connections(workspace_id, lower(name))
    WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_planning_connections_workspace
    ON planning_connections(workspace_id, status);

CREATE TABLE IF NOT EXISTS integration_events (
    event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
    connection_id UUID REFERENCES planning_connections(connection_id) ON DELETE SET NULL,
    user_id UUID REFERENCES users(user_id),
    event_type VARCHAR(80) NOT NULL,
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    request_id TEXT,
    ip_address INET,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_integration_events_workspace
    ON integration_events(workspace_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_integration_events_connection
    ON integration_events(connection_id, created_at DESC);

-- Down Migration

DROP INDEX IF EXISTS idx_integration_events_connection;
DROP INDEX IF EXISTS idx_integration_events_workspace;
DROP TABLE IF EXISTS integration_events;
DROP INDEX IF EXISTS idx_planning_connections_workspace;
DROP INDEX IF EXISTS uq_planning_connections_ws_name;
DROP TABLE IF EXISTS planning_connections;
