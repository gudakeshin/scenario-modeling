# ADR 0005: HyperFormula commercial license requirement

## Status

Accepted — production blocked until commercial license procured

## Context

HyperFormula is invoked with `licenseKey: "gpl-v3"` in `xlsxRuntime.ts` and `fidelityReconciliation.ts`. GPLv3 is copyleft; distributing a proprietary Deloitte product that embeds HyperFormula under GPLv3 creates legal exposure. Replacing HyperFormula across the fidelity pipeline would be a large engineering effort (L+).

## Decision

1. Add `HYPERFORMULA_LICENSE_KEY` to application config (default `gpl-v3` for development and test).
2. **Fail fast in production** when the key is still `gpl-v3` — the API process exits at boot.
3. **Business action (out of band):** procure a Handsoncode commercial license and set `HYPERFORMULA_LICENSE_KEY` in production secrets.
4. Both HyperFormula call sites read the key from `config`, never hard-coded.

## Alternatives considered

| Option | Effort | Outcome |
|--------|--------|---------|
| Purchase commercial license | S + procurement | Recommended — preserves existing fidelity pipeline |
| Replace with custom engine / SheetJS-only | L+ | High regression risk on formula fidelity |
| Remove XLSX simulation | M | Unacceptable — core product capability |

## Consequences

- Production deploys cannot ship until license key is set.
- CI/test environments continue using `gpl-v3` (NODE_ENV=test).
- ADR 0002 remains valid for architecture; this ADR governs licensing only.
