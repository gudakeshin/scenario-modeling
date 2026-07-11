# ADR 0004: DEMO_MODE

## Status

Accepted

## Context

Local demos and CI need a predictable P&L model and sample mappings without requiring every engineer to upload a full workbook. Production tenants must not silently apply demo-only formula repairs or seed mappings that do not match their uploaded model.

## Decision

`DEMO_MODE` is an optional env flag (truthy when `1` / `true`):

- When **true**: enables the hardcoded P&L formula repair map used by the simulation path, and `npm run db:seed` may insert demo `model_mappings` / fixture data for the seed admin.
- When **false** (default for production): no demo repair map; mappings come only from the tenant’s uploaded documents and validated model schema.

Documented in README and `backend/.env.example`. Leave false in production.

## Consequences

- Operators must set `DEMO_MODE` explicitly for demos; omitting it keeps production-safe behavior.
- Seed scripts and formula repair are gated on the same flag so demo data does not leak into real tenants.
- See also ADR 0002 (XLSX / HyperFormula) for the non-demo simulation path.
