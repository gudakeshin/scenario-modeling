# ADR 0004: DEMO_MODE

## Status

Accepted (updated July 2026)

## Context

Local demos and CI need a predictable P&L model and sample mappings without requiring every engineer to upload a full workbook. Production tenants must not silently apply demo-only seed mappings that do not match their uploaded model.

Separately, known P&L accounting identities (e.g. `gross_profit = revenue - cogs`) are useful as **guardrailed repairs** when LLM extraction produces a bare number for a typically-calculated metric. Those identities are not demo scaffolding — they are accounting facts — but they must only be applied when they reproduce the document's stated values within tolerance.

## Decision

`DEMO_MODE` is an optional env flag (truthy when `1` / `true`):

- When **true**: `npm run db:seed` may insert demo `model_mappings` / fixture data for the seed admin; identity repairs may be accepted without a source-value tie-out when typical values are missing.
- When **false** (default for production): no demo seed mappings.

**Identity repair (production-safe):** `KNOWN_CALCULATED_FORMULAS` may be proposed in any mode. A candidate is accepted only when:

1. All dependency variables are present with finite extracted values, and
2. Evaluating the candidate formula reproduces the metric's stated `typical_value` within `IDENTITY_REPAIR_TOLERANCE` (default 1%), and
3. The repaired formula compiles and is recorded with `provenance: "identity_repair"`.

If the tie-out fails, the candidate is rolled back and the original LLM formula (or generic dependency builder) is kept.

Documented in README and `backend/.env.example`. Leave `DEMO_MODE` false in production.

## Consequences

- Operators must set `DEMO_MODE` explicitly for demos; omitting it keeps production-safe seed behavior.
- Accounting identity validation is available in production and is evidence-gated, not a silent override.
- See also ADR 0002 (XLSX / HyperFormula) for the non-demo simulation path.
