-- Sign-off-ready assumptions register metadata.
ALTER TABLE scenario_parameters
    ADD COLUMN IF NOT EXISTS owner_user_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS source_citation TEXT,
    ADD COLUMN IF NOT EXISTS rationale TEXT,
    ADD COLUMN IF NOT EXISTS effective_from DATE,
    ADD COLUMN IF NOT EXISTS review_status VARCHAR(30) NOT NULL DEFAULT 'draft';

ALTER TABLE scenario_parameters
    DROP CONSTRAINT IF EXISTS scenario_parameters_review_status_check;
ALTER TABLE scenario_parameters
    ADD CONSTRAINT scenario_parameters_review_status_check
    CHECK (review_status IN ('draft', 'reviewed', 'approved', 'rejected'));
