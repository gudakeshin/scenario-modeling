-- Up Migration

CREATE TABLE IF NOT EXISTS llm_usage (
    usage_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id UUID,
    purpose VARCHAR(64) NOT NULL,
    model VARCHAR(128) NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    latency_ms INTEGER,
    succeeded BOOLEAN NOT NULL DEFAULT true,
    error_message TEXT,
    user_id UUID REFERENCES users(user_id),
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_llm_usage_created ON llm_usage(created_at);
CREATE INDEX IF NOT EXISTS idx_llm_usage_purpose ON llm_usage(purpose);

-- Down Migration

DROP INDEX IF EXISTS idx_llm_usage_purpose;
DROP INDEX IF EXISTS idx_llm_usage_created;
DROP TABLE IF EXISTS llm_usage;
