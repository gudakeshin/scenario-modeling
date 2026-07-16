-- Up Migration

CREATE TABLE IF NOT EXISTS chat_conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL DEFAULT 'New scenario',
    scenario_id UUID REFERENCES scenarios(scenario_id) ON DELETE SET NULL,
    session_id VARCHAR(255),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS chat_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
    role VARCHAR(20) NOT NULL, -- user | assistant
    content TEXT NOT NULL,
    -- Optional agentic/reasoning metadata mirroring frontend Message shape:
    -- thinking, agentTrace, causalChain, agentConfidence, agentCitations,
    -- previewPl, previewReconciliation, constraintViolations.
    metadata JSONB,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_conversations_workspace ON chat_conversations(workspace_id);
CREATE INDEX IF NOT EXISTS idx_chat_conversations_workspace_updated
    ON chat_conversations(workspace_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_conversations_user ON chat_conversations(user_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation_created
    ON chat_messages(conversation_id, created_at);

-- Down Migration

DROP INDEX IF EXISTS idx_chat_messages_conversation_created;
DROP INDEX IF EXISTS idx_chat_conversations_user;
DROP INDEX IF EXISTS idx_chat_conversations_workspace_updated;
DROP INDEX IF EXISTS idx_chat_conversations_workspace;
DROP TABLE IF EXISTS chat_messages;
DROP TABLE IF EXISTS chat_conversations;
