# ADR 0005: HyperFormula licensing — GPLv3 accepted

## Status

Accepted (revised July 2026) — GPLv3 key valid in all environments. Supersedes the earlier decision that blocked production boot until a commercial Handsoncode license was procured.

## Context

HyperFormula is dual-licensed: GPLv3 (free) or a commercial Handsoncode license. It is invoked with `licenseKey` from config in `xlsxRuntime.ts` and `fidelityReconciliation.ts`. The original ADR assumed this product would ship as a proprietary commercial offering, where embedding a GPLv3 library creates copyleft exposure, and therefore made the API process exit at boot in production when the key was `gpl-v3`.

That assumption no longer holds: **this is not a commercial product.** With no proprietary distribution, GPLv3 usage is legitimate:

- GPLv3 obligations (source availability, license propagation) are triggered by **distribution** of the software, not by running it. GPLv3 has no network-use clause (that is AGPL), so server-side use does not itself trigger copyleft.
- If the codebase is shared, it can be shared under GPLv3-compatible terms — acceptable for a non-commercial project.

Replacing HyperFormula was evaluated and rejected: no open-source alternative offers comparable Excel parity. `formulajs` implements functions but has no dependency graph or recalculation engine; `fast-formula-parser` parses and evaluates but lacks incremental graph recalc, named expressions, and broad function coverage. Either would regress the fidelity pipeline this product is built on.

## Decision

1. `HYPERFORMULA_LICENSE_KEY` remains in application config, defaulting to `gpl-v3`, and **`gpl-v3` is valid in every environment including production**. The boot-time rejection is removed.
2. Both HyperFormula call sites continue to read the key from `config`, never hard-coded.
3. If the product's licensing posture ever changes (proprietary distribution or commercial sale), procure a Handsoncode commercial license, set the key in production secrets, and revisit this ADR.

## Alternatives considered

| Option | Effort | Outcome |
|--------|--------|---------|
| Use HyperFormula under GPLv3 | None | **Accepted** — free, preserves the fidelity pipeline; obligations only trigger on distribution |
| Purchase commercial license | S + procurement | Unnecessary for a non-commercial product |
| Replace with formulajs / fast-formula-parser / custom engine | L+ | Rejected — no dependency-graph recalc or Excel parity; high regression risk |
| Remove XLSX simulation | M | Unacceptable — core product capability |

## Consequences

- Production deploys work out of the box with the free GPLv3 key; docker-compose defaults `HYPERFORMULA_LICENSE_KEY` to `gpl-v3`.
- The project must remain GPLv3-compatible if it is ever distributed; commercial repositioning requires a Handsoncode license first.
- ADR 0002 remains valid for the engine architecture; this ADR governs licensing only.
