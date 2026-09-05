# Monte Carlo performance baseline

## Methodology

- **Fixture:** in-memory `CompiledModel` (DAG) equivalent to the seeded demo P&L — not a HyperFormula workbook run.
- **Iterations:** 10,000
- **PRNG:** seeded `mulberry32` (fixed seed for reproducibility)
- **Distributions:** default normal/lognormal levers as used by `monteCarloService`
- **Machine note:** record OS / CPU when updating the measured number below

## How to measure

From `backend/`:

```bash
# Optional one-off microbench (adjust imports to your fixture):
npx tsx -e "
import { performance } from 'node:perf_hooks';
// Import and run monteCarloService against a CompiledModel fixture with seed=42, iterations=10000
// console.log(ms)
"
```

Or time a single authenticated API call:

```bash
time curl -s -X POST \"\$API/api/v1/scenarios/\$ID/monte-carlo\" \\
  -H \"Authorization: Bearer \$TOKEN\" \\
  -H \"Content-Type: application/json\" \\
  -d '{\"iterations\":10000,\"seed\":42}'
```

Prefer the service-level bench so HTTP/LLM noise is excluded.

## Recorded baseline

| Date | Iterations | Seed | Approx. wall time | Notes |
|------|------------|------|-------------------|--------|
| 2026-07-11 | 10,000 | 42 | **4.5 ms** | Local `npx tsx` on CompiledModel fixture (3 inputs + 3 outputs), Apple Darwin / Node 23. Sampling via `mulberry32` + `normalRandom` + `model.evaluate`. HyperFormula workbook MC is slower (seconds). |
