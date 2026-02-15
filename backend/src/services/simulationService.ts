import { pool } from "../db/index.js";
import { getModelDefinition, getPLMetrics, getPercentDeltaVars, type ModelDefinition, type TimeHorizon } from "../models/registry.js";

export interface ScenarioParameterRow {
  mapped_variable_id: string;
  scenario_value: number;
  status: string;
}

/** Single-period P&L snapshot */
export interface PeriodResult {
  period: string;         // e.g. "2024-Q1", "2024-01"
  pl: Record<string, number>;
  variables: Record<string, number>;
}

export interface SimulationOutput {
  /** Aggregate (total) P&L across all periods */
  pl: Record<string, number>;
  /** Aggregate variable values (from final period for rates, sum for absolutes) */
  variables: Record<string, number>;
  /** Per-period breakdown (quarterly or monthly) */
  periods: PeriodResult[];
  /** Metadata */
  period_count: number;
  granularity: "monthly" | "quarterly";
}

function topologicalSort(variables: { id: string; dependencies: string[] }[]): string[] {
  const order: string[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const byId = new Map(variables.map((v) => [v.id, v]));

  function visit(id: string) {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error(`Circular dependency involving ${id}`);
    visiting.add(id);
    const v = byId.get(id);
    if (v) for (const d of v.dependencies) visit(d);
    visiting.delete(id);
    visited.add(id);
    order.push(id);
  }

  for (const v of variables) visit(v.id);
  return order; // DFS post-order: dependencies are pushed before dependents
}

/** Simple formula eval: numbers, + - * / ( ), and variable refs. */
function evaluateFormula(formula: string, ctx: Record<string, number>): number {
  let expr = formula.trim();
  for (const [k, v] of Object.entries(ctx)) {
    expr = expr.replace(new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g"), String(v));
  }
  if (!/^[\d\s+\-*/().]+$/.test(expr)) {
    const missing = expr.match(/\b[a-zA-Z_][a-zA-Z0-9_]*\b/g);
    throw new Error(`Unknown variable(s) in formula: ${missing?.join(", ") || formula}`);
  }
  try {
    return new Function(`return (${expr})`)();
  } catch (e) {
    throw new Error(`Formula error: ${(e as Error).message}`);
  }
}

// ── Time horizon helpers ──

function generatePeriodLabels(horizon: TimeHorizon): string[] {
  const labels: string[] = [];
  if (horizon.granularity === "quarterly") {
    // Parse "2024-Q1" format
    const startMatch = horizon.start.match(/(\d{4})-Q(\d)/);
    const endMatch = horizon.end.match(/(\d{4})-Q(\d)/);
    if (!startMatch || !endMatch) return [horizon.start]; // fallback single period
    let year = parseInt(startMatch[1]);
    let quarter = parseInt(startMatch[2]);
    const endYear = parseInt(endMatch[1]);
    const endQuarter = parseInt(endMatch[2]);
    while (year < endYear || (year === endYear && quarter <= endQuarter)) {
      labels.push(`${year}-Q${quarter}`);
      quarter++;
      if (quarter > 4) { quarter = 1; year++; }
    }
  } else {
    // Monthly: parse "2024-01" or "2024-Q1" -> expand to months
    const startMatch = horizon.start.match(/(\d{4})-Q(\d)/);
    const endMatch = horizon.end.match(/(\d{4})-Q(\d)/);
    if (startMatch && endMatch) {
      // Convert quarters to months
      let year = parseInt(startMatch[1]);
      let month = (parseInt(startMatch[2]) - 1) * 3 + 1;
      const endYear = parseInt(endMatch[1]);
      const endMonth = parseInt(endMatch[2]) * 3;
      while (year < endYear || (year === endYear && month <= endMonth)) {
        labels.push(`${year}-${String(month).padStart(2, "0")}`);
        month++;
        if (month > 12) { month = 1; year++; }
      }
    } else {
      // Try "2024-01" to "2024-12" format
      const sMatch = horizon.start.match(/(\d{4})-(\d{2})/);
      const eMatch = horizon.end.match(/(\d{4})-(\d{2})/);
      if (sMatch && eMatch) {
        let year = parseInt(sMatch[1]);
        let month = parseInt(sMatch[2]);
        const endYear = parseInt(eMatch[1]);
        const endMonth = parseInt(eMatch[2]);
        while (year < endYear || (year === endYear && month <= endMonth)) {
          labels.push(`${year}-${String(month).padStart(2, "0")}`);
          month++;
          if (month > 12) { month = 1; year++; }
        }
      } else {
        labels.push(horizon.start);
      }
    }
  }
  return labels.length > 0 ? labels : [horizon.start];
}

// ── Simulation core ──

/**
 * Evaluate a single period of the model with given overrides.
 * Returns the full variable context for that period.
 */
function evaluatePeriod(
  model: ModelDefinition,
  order: string[],
  overrides: Map<string, number>,
  percentDeltaVars: Set<string>,
  periodIndex: number,
  prevCtx: Record<string, number> | null,
): Record<string, number> {
  // Base pass
  const baseCtx: Record<string, number> = {};
  for (const id of order) {
    const v = model.variables.find((x) => x.id === id);
    if (!v) continue;
    try {
      const val = evaluateFormula(v.formula, baseCtx);
      baseCtx[id] = Number.isFinite(val) ? val : 0;
    } catch {
      baseCtx[id] = 0;
    }
  }

  // Apply overrides
  const ctx: Record<string, number> = { ...baseCtx };

  // If previous period context exists, allow growth compounding for input vars
  if (prevCtx) {
    for (const id of order) {
      const v = model.variables.find((x) => x.id === id);
      if (v && v.dependencies.length === 0 && prevCtx[id] != null) {
        // Carry forward input values (for compounding growth scenarios)
        ctx[id] = prevCtx[id];
      }
    }
  }

  for (const [id, scenarioValue] of overrides) {
    if (!Number.isFinite(scenarioValue)) continue;
    if (percentDeltaVars.has(id) && scenarioValue >= 0 && scenarioValue <= 100 && baseCtx[id] != null) {
      // For multi-period: apply % delta to the base for each period
      // (not compounding — each period independently applies the same % change to its base)
      const baseVal = prevCtx && prevCtx[id] != null ? prevCtx[id] : baseCtx[id];
      ctx[id] = Math.round(baseVal * (1 + scenarioValue / 100) * 100) / 100;
    } else {
      ctx[id] = scenarioValue;
    }
  }

  // Re-evaluate dependents
  for (const id of order) {
    if (overrides.has(id)) continue;
    // Skip input vars that we carried forward
    const v = model.variables.find((x) => x.id === id);
    if (!v) continue;
    if (v.dependencies.length === 0 && prevCtx && !overrides.has(id)) continue;
    try {
      const val = evaluateFormula(v.formula, ctx);
      ctx[id] = Number.isFinite(val) ? val : 0;
    } catch {
      ctx[id] = 0;
    }
  }

  return ctx;
}

const SIMULATION_TIMEOUT_MS = Number(process.env.SIMULATION_TIMEOUT_MS) || 60_000;

/** Wraps a promise with a timeout. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

export async function runSimulation(scenarioId: string): Promise<SimulationOutput> {
  return withTimeout(_runSimulation(scenarioId), SIMULATION_TIMEOUT_MS, "Simulation");
}

async function _runSimulation(scenarioId: string): Promise<SimulationOutput> {
  const scenarioRes = await pool.query(
    "SELECT model_version_hash FROM scenarios WHERE scenario_id = $1",
    [scenarioId]
  );
  if (scenarioRes.rows.length === 0) throw new Error("Scenario not found");
  const modelVersion = scenarioRes.rows[0].model_version_hash;

  const paramsRes = await pool.query<ScenarioParameterRow & { confidence_score?: number }>(
    `SELECT mapped_variable_id, scenario_value, status, confidence_score FROM scenario_parameters WHERE scenario_id = $1 AND status IN ('pending', 'accepted', 'modified')`,
    [scenarioId]
  );
  const overrides = new Map<string, number>();
  for (const row of paramsRes.rows) {
    overrides.set(row.mapped_variable_id, Number(row.scenario_value));
  }

  const model = await getModelDefinition(modelVersion);
  const order = topologicalSort(model.variables);
  const percentDeltaVars = getPercentDeltaVars(model);
  const plMetricIds = getPLMetrics(model);

  // ── Multi-period evaluation ──
  const periodLabels = generatePeriodLabels(model.time_horizon);
  const periods: PeriodResult[] = [];
  let prevCtx: Record<string, number> | null = null;

  for (let i = 0; i < periodLabels.length; i++) {
    const ctx = evaluatePeriod(model, order, overrides, percentDeltaVars, i, prevCtx);

    const periodPl: Record<string, number> = {};
    for (const id of plMetricIds) {
      if (id in ctx) periodPl[id] = Math.round(ctx[id] * 100) / 100;
    }

    periods.push({
      period: periodLabels[i],
      pl: periodPl,
      variables: { ...ctx },
    });

    prevCtx = ctx;
  }

  // ── Aggregate: sum P&L across all periods ──
  const aggregatePl: Record<string, number> = {};
  for (const id of plMetricIds) {
    let total = 0;
    for (const p of periods) {
      total += p.pl[id] || 0;
    }
    aggregatePl[id] = Math.round(total * 100) / 100;
  }

  // Aggregate variables: use last period values (most representative for rates)
  const lastPeriodVars = periods.length > 0 ? periods[periods.length - 1].variables : {};

  // Store both aggregate and period breakdown
  const outputData = {
    aggregate: aggregatePl,
    periods: periods.map((p) => ({ period: p.period, pl: p.pl })),
    granularity: model.time_horizon.granularity,
    period_count: periods.length,
  };

  await pool.query(
    `INSERT INTO scenario_outputs (scenario_id, output_type, output_data) VALUES ($1, 'pl', $2)`,
    [scenarioId, JSON.stringify(outputData)]
  );
  await pool.query(
    `UPDATE scenarios SET status = 'completed', updated_at = NOW() WHERE scenario_id = $1`,
    [scenarioId]
  );

  return {
    pl: aggregatePl,
    variables: lastPeriodVars,
    periods,
    period_count: periods.length,
    granularity: model.time_horizon.granularity,
  };
}
