-- Up Migration

-- Hash-chain + request metadata for append-only audit trail.
-- ip_address / user_agent may already exist from baseline (INET / TEXT);
-- ADD COLUMN IF NOT EXISTS is a no-op when present.
ALTER TABLE audit_trail
    ADD COLUMN IF NOT EXISTS prev_hash TEXT,
    ADD COLUMN IF NOT EXISTS row_hash TEXT,
    ADD COLUMN IF NOT EXISTS request_id TEXT,
    ADD COLUMN IF NOT EXISTS ip_address TEXT,
    ADD COLUMN IF NOT EXISTS user_agent TEXT;

-- TIMESTAMPTZ so ISO strings hashed at write time round-trip for verify.
ALTER TABLE audit_trail
    ALTER COLUMN timestamp TYPE TIMESTAMPTZ
    USING timestamp AT TIME ZONE 'UTC';

-- Single-row chain head (locked with FOR UPDATE on insert).
CREATE TABLE IF NOT EXISTS audit_chain_head (
    id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    last_hash TEXT,
    last_audit_id UUID
);

INSERT INTO audit_chain_head (id, last_hash, last_audit_id)
VALUES (1, NULL, NULL)
ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION audit_trail_immutable()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'audit_trail is immutable';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_trail_no_mutate ON audit_trail;
CREATE TRIGGER audit_trail_no_mutate
    BEFORE UPDATE OR DELETE ON audit_trail
    FOR EACH ROW
    EXECUTE FUNCTION audit_trail_immutable();

-- Down Migration

DROP TRIGGER IF EXISTS audit_trail_no_mutate ON audit_trail;
DROP FUNCTION IF EXISTS audit_trail_immutable();
DROP TABLE IF EXISTS audit_chain_head;
ALTER TABLE audit_trail DROP COLUMN IF EXISTS prev_hash;
ALTER TABLE audit_trail DROP COLUMN IF EXISTS row_hash;
ALTER TABLE audit_trail DROP COLUMN IF EXISTS request_id;
ALTER TABLE audit_trail
    ALTER COLUMN timestamp TYPE TIMESTAMP
    USING timezone('UTC', timestamp);
-- Do not drop ip_address / user_agent — they predate this migration on
-- databases created from baseline.
