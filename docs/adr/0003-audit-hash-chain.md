# ADR 0003: Audit hash chain + immutability trigger

## Status

Accepted

## Context

PRD requires an append-only, compliance-oriented audit trail. Application discipline alone is not enough if the shared DB user can UPDATE/DELETE rows.

## Decision

1. On each `logAudit`, lock `audit_chain_head` (`FOR UPDATE`), set `prev_hash` to the previous head, compute `row_hash = sha256(prev_hash || canonical_payload)`, insert, advance the head.
2. Install a `BEFORE UPDATE OR DELETE` trigger that raises `audit_trail is immutable`.
3. Expose `GET /api/v1/audit/verify` (admin) to walk the chain by `timestamp, audit_id`.

No separate DB role / REVOKE in migrations — this deploy shares one app DB user; triggers are the immutability control.

## Consequences

- Pre-migration rows without hashes are treated as a leading legacy prefix by `verifyAuditChain` (noted in `reason` when present). Unhashed rows after chained rows fail verification.
- Superuser/table-owner sessions can still disable triggers — protect Postgres credentials.
- Request metadata (`request_id`, IP, user-agent) is recorded when available via request context.
- Restart the API after applying the migration so writers always populate the hash columns.
