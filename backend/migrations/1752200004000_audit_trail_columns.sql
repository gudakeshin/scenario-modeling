-- Up Migration

-- Schema-drift fix: the baseline migration used CREATE TABLE IF NOT EXISTS,
-- which no-ops when audit_trail already exists from an earlier schema
-- version. touched_levers_snapshot was added to that CREATE TABLE
-- statement but never actually landed on databases where the table
-- predated it — every logAudit() call with a lever snapshot then failed
-- with "column does not exist". ALTER ... ADD COLUMN IF NOT EXISTS is
-- idempotent and safe to run whether or not the column is already there.
ALTER TABLE audit_trail
    ADD COLUMN IF NOT EXISTS touched_levers_snapshot JSONB;

-- Down Migration

ALTER TABLE audit_trail DROP COLUMN IF EXISTS touched_levers_snapshot;
