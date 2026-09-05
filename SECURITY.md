# Security

## Auth model

- **Provider:** local JWT (`AUTH_PROVIDER=local`). OIDC is not implemented yet.
- **Tokens:** short-lived access JWT + refresh token stored hashed in Postgres (`refresh_tokens`).
- **Transport:** `Authorization: Bearer <access_token>`. Cookies are not used for API auth.
- **Roles:** `viewer` < `analyst` < `approver` < `admin` (hierarchy enforced in `requireRole`).
- **Registration:** first-user bootstrap and/or admin-gated register — see `backend/src/routes/auth.ts`.
- **Not supported:** legacy `x-user-id` header identity, client-chosen role switching.

## JWT / secret rotation

1. Generate a new secret: `openssl rand -base64 48` (≥32 characters required by config).
2. Deploy `JWT_SECRET` to all API instances atomically (or briefly accept both secrets if you add dual-key verification — not built-in today).
3. Existing access tokens signed with the old secret become invalid immediately after cutover.
4. Users re-authenticate via login / refresh. If refresh verification also depends on the same secret material in your deployment, force re-login for all sessions.
5. Rotate Anthropic / Perplexity / LlamaCloud / embedding keys in the provider consoles, then update env and restart; no DB migration required for API keys.

## Audit immutability & verify runbook

**Controls**

- Application writes only `INSERT` into `audit_trail` with `prev_hash` / `row_hash` (SHA-256 chain).
- Postgres trigger `audit_trail_no_mutate` raises on `UPDATE` or `DELETE`.
- Chain head is a single row in `audit_chain_head`, locked with `FOR UPDATE` during append.

**Verify**

```bash
# As an admin JWT
curl -sS -H "Authorization: Bearer $ACCESS_TOKEN" \
  http://localhost:4000/api/v1/audit/verify
```

Response shape: `{ valid, checked, firstBadId?, reason? }`.

**If `valid: false`**

1. Note `firstBadId` and `reason` (gap in chain, missing hash after chained rows, or payload mismatch).
2. Do **not** attempt to UPDATE/DELETE audit rows (blocked by trigger).
3. Preserve DB backups from before the anomaly; compare row counts and hashes offline.
4. Investigate app/DB access: who had write access to Postgres as a superuser (triggers can be bypassed by owners/superusers).
5. Treat as a security incident if tampering is confirmed; restore from known-good backup only under change control.

**Upgraded databases:** rows written before the hash-chain migration have null `row_hash`. Verify skips a leading legacy prefix and checks the chained suffix; `reason` may note how many legacy rows were skipped. Unhashed rows after chained rows are a failure.

**Caveat:** app and migrations share one DB role in this deploy model. Immutability is enforced by triggers, not by a separate least-privilege DB role.

## Reporting vulnerabilities

Report suspected security issues privately to the project maintainers (Deloitte internal channel for this repository). Do not file public issues with exploit details.
