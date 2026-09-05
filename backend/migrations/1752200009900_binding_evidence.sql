-- Phase 1.3: lever-binding evidence for parameter review
ALTER TABLE scenario_parameters
  ADD COLUMN IF NOT EXISTS binding_evidence JSONB,
  ADD COLUMN IF NOT EXISTS needs_review BOOLEAN NOT NULL DEFAULT FALSE;
