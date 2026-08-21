-- Up Migration

-- Data-quality findings raised against an uploaded workbook, and the analyst's
-- decision on each.
--
-- Structural ingestion warnings say what the file does that the engine cannot
-- reproduce. These say what the *data* does that a reader would not expect: a
-- month fifty times its neighbours, a cached #REF!, a schedule on the wrong
-- year, an assumption wired to nothing. Each one blocks the model from being
-- simulated until somebody has looked at it and said so on the record, because
-- an answer built on unexamined data is worse than no answer.

CREATE TABLE IF NOT EXISTS data_quality_findings (
    finding_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID NOT NULL REFERENCES documents(document_id) ON DELETE CASCADE,
    workspace_id UUID REFERENCES workspaces(workspace_id) ON DELETE CASCADE,

    -- Hash of (code, sheet, cells, rounded values). Stable while the data is
    -- unchanged, so an acknowledgement survives re-ingestion; different once a
    -- value moves, so a changed number is reviewed again rather than inheriting
    -- a decision made about a different number.
    finding_key TEXT NOT NULL,

    code VARCHAR(48) NOT NULL,
    severity VARCHAR(16) NOT NULL CHECK (severity IN ('error', 'warning')),
    title TEXT NOT NULL,
    message TEXT NOT NULL,

    sheet VARCHAR(255) NOT NULL,
    cells TEXT[] NOT NULL DEFAULT '{}',
    row_label TEXT,
    evidence JSONB,

    status VARCHAR(16) NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'acknowledged')),
    note TEXT,
    acknowledged_by UUID REFERENCES users(user_id),
    acknowledged_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (document_id, finding_key)
);

CREATE INDEX IF NOT EXISTS idx_dq_findings_document
    ON data_quality_findings(document_id, status);
CREATE INDEX IF NOT EXISTS idx_dq_findings_blocking
    ON data_quality_findings(document_id)
    WHERE status = 'open' AND severity = 'error';

-- Down Migration

DROP TABLE IF EXISTS data_quality_findings CASCADE;
