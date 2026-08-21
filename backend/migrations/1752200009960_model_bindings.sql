-- Up Migration

-- Semantic binding layer over the stored cell snapshot.
--
-- The runtime previously derived lever/output identity from row labels alone
-- (`toId(label)`), so a workbook repeating a label across sections collapsed
-- several distinct drivers into one id and bound whichever cell was seen last.
-- This table gives every binding a stable, unique, reviewable identity together
-- with the structural facts the runtime needs: which cell to write under a
-- scenario toggle, which cell holds the period total, and what the binding
-- probe observed.

CREATE TABLE IF NOT EXISTS model_bindings (
    binding_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID NOT NULL REFERENCES documents(document_id) ON DELETE CASCADE,
    workspace_id UUID REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
    artifact_version TEXT,

    binding_kind VARCHAR(16) NOT NULL CHECK (binding_kind IN ('lever', 'output')),
    binding_slug VARCHAR(255) NOT NULL,
    aliases TEXT[] NOT NULL DEFAULT '{}',

    label TEXT NOT NULL,
    block_label TEXT,

    sheet VARCHAR(255) NOT NULL,
    cell VARCHAR(16),
    -- "Active" column twin of a Base|Bull|Bear|Active block: the cell the
    -- workbook's formulas actually read, and therefore the cell to write.
    active_cell VARCHAR(16),
    -- Cell whose value selects which column active_cell resolves to.
    toggle_cell VARCHAR(320),
    -- The row's own period-total cell (e.g. P&L!O4 = SUM(C4:N4)).
    aggregate_cell VARCHAR(16),

    unit VARCHAR(32),
    -- constant_input: safe to override. derived: computed, never a lever.
    -- reference: identifier data (GL codes, part numbers).
    role VARCHAR(32) NOT NULL DEFAULT 'constant_input'
        CHECK (role IN ('constant_input', 'derived', 'reference')),
    canonical_metric VARCHAR(64),
    base_value NUMERIC,

    -- Directional probe result from XlsxModelRuntime.probeBindings.
    probe_evidence JSONB,
    moves_outputs BOOLEAN,

    status VARCHAR(16) NOT NULL DEFAULT 'proposed'
        CHECK (status IN ('proposed', 'confirmed', 'rejected')),
    reviewed_by UUID REFERENCES users(user_id),
    reviewed_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Uniqueness is the whole point: a duplicate slug is the bug this table
    -- exists to make impossible, so it is enforced by the schema rather than
    -- resolved by last-write-wins in memory.
    UNIQUE (document_id, binding_kind, binding_slug)
);

CREATE INDEX IF NOT EXISTS idx_model_bindings_document
    ON model_bindings(document_id, binding_kind);
CREATE INDEX IF NOT EXISTS idx_model_bindings_workspace
    ON model_bindings(workspace_id);
CREATE INDEX IF NOT EXISTS idx_model_bindings_review
    ON model_bindings(document_id) WHERE status = 'proposed' AND moves_outputs = false;

-- Down Migration

DROP TABLE IF EXISTS model_bindings CASCADE;
