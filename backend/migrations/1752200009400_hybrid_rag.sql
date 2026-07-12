-- Up Migration
-- Portable embedding storage (JSONB float array). Avoids requiring pgvector.

ALTER TABLE document_chunks
  ADD COLUMN IF NOT EXISTS embedding JSONB;

CREATE INDEX IF NOT EXISTS idx_document_chunks_has_embedding
  ON document_chunks ((embedding IS NOT NULL));

-- Minimal document conversation memory (workspace-scoped chat with RAG)
CREATE TABLE IF NOT EXISTS document_conversations (
  conversation_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  document_id UUID REFERENCES documents(document_id) ON DELETE SET NULL,
  user_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
  title VARCHAR(255),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS document_conversation_messages (
  message_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES document_conversations(conversation_id) ON DELETE CASCADE,
  role VARCHAR(20) NOT NULL,
  content TEXT NOT NULL,
  sources JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_document_conversations_workspace
  ON document_conversations(workspace_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_document_conversation_messages_conv
  ON document_conversation_messages(conversation_id, created_at);

-- Down Migration
-- DROP INDEX IF EXISTS idx_document_conversation_messages_conv;
-- DROP INDEX IF EXISTS idx_document_conversations_workspace;
-- DROP TABLE IF EXISTS document_conversation_messages;
-- DROP TABLE IF EXISTS document_conversations;
-- DROP INDEX IF EXISTS idx_document_chunks_has_embedding;
-- ALTER TABLE document_chunks DROP COLUMN IF EXISTS embedding;
