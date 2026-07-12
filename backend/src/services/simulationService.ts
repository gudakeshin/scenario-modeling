import { pool } from "../db/index.js";
import { getModelDefinition, getPLMetrics, type TimeHorizon } from "../models/registry.js";
import { CompiledModel } from "./expression.js";
import {
  getEvaluableModelForScenario,
  loadScenarioOverrides,
  resolveOverridesToAbsolute,
  toDimensionalOverrides,
  type ResolvedModel,
  type ScenarioOverride,
} from "./modelResolver.js";
import { DimensionalModel } from "./dimensionalModel.js";
import { simulationsRun } from "../metrics.js";
import { logger } from "../logger.js";
import {
  aggregatePeriodPl,
  hasPeriodGrowth,
  periodOverrides,
} from "./simulationAggregation.js";

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
  simulation_mode: "formula_dag" | "xlsx_cell_graph" | "external_model";
  absurdity_warnings?: string[];
  notices?: string[];
  dimensional?: {
    dimensions: Array<{ id: string; name: string; type: string }>;
    member_catalog: Record<string, Record<string, string>>;
    breakdowns: Record<string, Record<string, Record<string, number>>>;
  };
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

// ── Shared helpers ──

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

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

const MAX_REASONABLE_CHANGE_PCT = 200;

/** Flag output changes disproportionate to any plausible scenario input. */
function absurdityWarnings(
  basePl: Record<string, number>,
  scenarioPl: Record<string, number>,
): string[] {
  const warnings: string[] = [];
  for (const [metric, scenarioVal] of Object.entries(scenarioPl)) {
    const baseVal = basePl[metric];
    if (baseVal == null || Math.abs(baseVal) <= 0.01) continue;
    const changePct = ((scenarioVal - baseVal) / Math.abs(baseVal)) * 100;
    if (Math.abs(changePct) > MAX_REASONABLE_CHANGE_PCT) {
      warnings.push(
        `${metric} changed by ${changePct.toFixed(0)}% — this seems disproportionate to the scenario inputs. ` +
        `Base: ${baseVal.toLocaleString()}, Scenario: ${scenarioVal.toLocaleString()}`
      );
    }
  }
  return warnings;
}

function unresolvedNotices(unresolved: string[]): string[] {
  if (unresolved.length === 0) return [];
  return [
    `Percent changes for ${unresolved.join(", ")} could not be applied — the model has no non-zero base value for them.`,
  ];
}

async function storeAndComplete(scenarioId: string, outputData: Record<string, unknown>): Promise<void> {
  await pool.query(
    `INSERT INTO scenario_outputs (scenario_id, output_type, output_data) VALUES ($1, 'pl', $2)`,
    [scenarioId, JSON.stringify(outputData)],
  );
  await pool.query(
    `UPDATE scenarios SET status = 'completed', updated_at = NOW() WHERE scenario_id = $1`,
    [scenarioId],
  );
}

// ── Entry point ──

export async function runSimulation(scenarioId: string): Promise<SimulationOutput> {
  return withTimeout(_runSimulationDispatcher(scenarioId), SIMULATION_TIMEOUT_MS, "Simulation");
}

async function _runSimulationDispatcher(scenarioId: string): Promise<SimulationOutput> {
  const resolved = await getEvaluableModelForScenario(scenarioId);
  const overrides = await loadScenarioOverrides(scenarioId);
  if (resolved.source === "external_model") {
    simulationsRun.inc({ engine: "dimensional" });
    return _runDimensionalSimulation(scenarioId, resolved, overrides);
  }
  if (resolved.source === "xlsx_cell_graph") {
    simulationsRun.inc({ engine: "xlsx" });
    return _runXlsxSimulation(scenarioId, resolved, overrides);
  }
  simulationsRun.inc({ engine: "formula" });
  return _runFormulaSimulation(scenarioId, overrides);
}

// ── External dimensional model path ──

async function _runDimensionalSimulation(
  scenarioId: string,
  resolved: ResolvedModel,
  overrides: ScenarioOverride[],
): Promise<SimulationOutput> {
  const model = resolved.model as DimensionalModel;
  const def = resolved.dimensionalDef!;
  const dimOverrides = toDimensionalOverrides(overrides);

  const baseResult = model.evaluateDimensional([]);
  const scenarioResult = model.evaluateDimensional(dimOverrides);

  const pl: Record<string, number> = {};
  const basePl: Record<string, number> = {};
  for (const id of model.outputIds) {
    pl[id] = round2(scenarioResult.totals[id] ?? 0);
    basePl[id] = round2(baseResult.totals[id] ?? 0);
  }
  const variables: Record<string, number> = {};
  for (const input of model.inputs) {
    variables[input.id] = round2(scenarioResult.totals[input.id] ?? input.base);
  }

  // Periods: slice time dimension via valueAt
  const timeDimId = def.time_dimension_id;
  const timeDim = timeDimId ? def.dimensions.find((d) => d.id === timeDimId) : undefined;
  const timeLeaves = timeDim
    ? timeDim.members.filter((m) => m.isLeaf).sort((a, b) => a.ordinal - b.ordinal)
    : [];

  const periods: PeriodResult[] = [];
  if (timeLeaves.length > 0) {
    for (const leaf of timeLeaves) {
      const periodPl: Record<string, number> = {};
      for (const id of model.outputIds) {
        const v = scenarioResult.valueAt(id, { [timeDimId!]: leaf.id });
        if (v !== undefined) periodPl[id] = round2(v);
      }
      periods.push({
        period: leaf.name,
        pl: periodPl,
        variables: { ...periodPl },
      });
    }
  } else {
    periods.push({ period: "Total", pl, variables: { ...variables } });
  }

  // One-level breakdowns per pl_metric per dim
  const breakdowns: Record<string, Record<string, Record<string, number>>> = {};
  for (const metricId of model.outputIds) {
    breakdowns[metricId] = {};
    for (const dim of def.dimensions) {
      if (dim.type === "version") continue;
      const slice: Record<string, number> = {};
      // Top-level children of roots (or all non-root members at depth 1)
      const roots = dim.members.filter((m) => !m.parentId);
      const level1 =
        roots.length > 0
          ? dim.members.filter((m) => roots.some((r) => m.parentId === r.id) || roots.includes(m))
          : dim.members.filter((m) => m.isLeaf);
      for (const m of level1) {
        const v = scenarioResult.valueAt(metricId, { [dim.id]: m.id });
        if (v !== undefined) slice[m.id] = round2(v);
      }
      if (Object.keys(slice).length > 0) breakdowns[metricId][dim.id] = slice;
    }
  }

  const dimensional = {
    dimensions: def.dimensions.map((d) => ({ id: d.id, name: d.name, type: d.type })),
    member_catalog: Object.fromEntries(
      def.dimensions.map((dimension) => [
        dimension.id,
        Object.fromEntries(dimension.members.map((member) => [member.id, member.name])),
      ]),
    ),
    breakdowns,
  };

  const warnings = absurdityWarnings(basePl, pl);
  const notices: string[] = [];
  if (def.build_warnings?.length) {
    notices.push(...def.build_warnings);
  }

  const outputData: Record<string, unknown> = {
    aggregate: pl,
    base_pl: basePl,
    periods: periods.map((p) => ({ period: p.period, pl: p.pl })),
    granularity: def.time_horizon.granularity,
    period_count: periods.length,
    simulation_mode: "external_model",
    dimensional,
    ...(warnings.length > 0 ? { absurdity_warnings: warnings } : {}),
    ...(notices.length > 0 ? { notices } : {}),
  };
  await storeAndComplete(scenarioId, outputData);

  return {
    pl,
    variables,
    periods,
    period_count: periods.length,
    granularity: def.time_horizon.granularity,
    simulation_mode: "external_model",
    dimensional,
    ...(warnings.length > 0 ? { absurdity_warnings: warnings } : {}),
    ...(notices.length > 0 ? { notices } : {}),
  };
}

// ── XLSX path: real cell-level propagation via HyperFormula ──

async function _runXlsxSimulation(
  scenarioId: string,
  resolved: ResolvedModel,
  overrides: ScenarioOverride[],
): Promise<SimulationOutput> {
  const runtime = resolved.model;
  const { absolute, unresolved } = resolveOverridesToAbsolute(runtime, overrides);

  const baseOut = runtime.evaluate({});
  const scenarioOut = runtime.evaluate(absolute);

  const pl: Record<string, number> = {};
  const basePl: Record<string, number> = {};
  for (const id of runtime.outputIds) {
    pl[id] = round2(scenarioOut[id] ?? 0);
    basePl[id] = round2(baseOut[id] ?? 0);
  }
  const variables: Record<string, number> = {};
  for (const input of runtime.inputs) {
    variables[input.id] = round2(scenarioOut[input.id] ?? input.base);
  }

  const warnings = absurdityWarnings(basePl, pl);
  const notices = unresolvedNotices(unresolved);

  const outputData: Record<string, unknown> = {
    aggregate: pl,
    base_pl: basePl,
    periods: [{ period: "FY", pl }],
    granularity: "quarterly",
    period_count: 1,
    simulation_mode: "xlsx_cell_graph",
    ...(warnings.length > 0 ? { absurdity_warnings: warnings } : {}),
    ...(notices.length > 0 ? { notices } : {}),
  };
  await storeAndComplete(scenarioId, outputData);

  return {
    pl,
    variables,
    periods: [{ period: "FY", pl, variables }],
    period_count: 1,
    granularity: "quarterly",
    simulation_mode: "xlsx_cell_graph",
    ...(warnings.length > 0 ? { absurdity_warnings: warnings } : {}),
    ...(notices.length > 0 ? { notices } : {}),
  };
}

// ── Formula-DAG path (models built from text documents) ──

async function _runFormulaSimulation(
  scenarioId: string,
  overrides: ScenarioOverride[],
): Promise<SimulationOutput> {
  const scenarioRes = await pool.query(
    "SELECT model_version_hash FROM scenarios WHERE scenario_id = $1",
    [scenarioId]
  );
  if (scenarioRes.rows.length === 0) throw new Error("Scenario not found");
  const modelVersion = scenarioRes.rows[0].model_version_hash;

  const modelDef = await getModelDefinition(modelVersion);
  if (!modelDef) throw new Error("No model found. Please build a model from your documents first.");
  const model = new CompiledModel(modelDef);
  const plMetricIds = getPLMetrics(modelDef);

  const { absolute, unresolved } = resolveOverridesToAbsolute(model, overrides);
  // Absolute overrides may also pin ids the model doesn't list as inputs
  // (e.g. calculated vars explicitly set by the user) — evaluate() honors
  // any known id present in the map and ignores unknown synthetic ids.

  const baseCtx = model.baseValues();
  const periodLabels = generatePeriodLabels(modelDef.time_horizon);
  const useGrowth = hasPeriodGrowth(modelDef);

  // Absolute scenario overrides are the period-0 base; growth compounds from there.
  const periods: PeriodResult[] = periodLabels.map((label, t) => {
    const absForPeriod = useGrowth ? periodOverrides(modelDef, absolute, t, baseCtx) : absolute;
    const scenarioCtx = model.evaluate(absForPeriod);
    const periodPl: Record<string, number> = {};
    for (const id of plMetricIds) {
      if (id in scenarioCtx) periodPl[id] = round2(scenarioCtx[id]);
    }
    return { period: label, pl: periodPl, variables: { ...scenarioCtx } };
  });

  const aggregatePl = aggregatePeriodPl(model, modelDef, periods, absolute);
  const lastPeriodVars = periods.length > 0 ? periods[periods.length - 1].variables : {};

  const basePl: Record<string, number> = {};
  for (const id of plMetricIds) basePl[id] = round2(baseCtx[id] ?? 0);
  const singlePeriodPl: Record<string, number> = periods[0]?.pl ?? {};
  const warnings = absurdityWarnings(basePl, singlePeriodPl);
  const notices = unresolvedNotices(unresolved);

  const assumed = modelDef.variables
    .filter((v) => v.provenance === "assumed")
    .map((v) => v.id);
  if (assumed.length > 0) {
    notices.push(
      `Model includes assumed-0 variables (not extracted from documents): ${assumed.join(", ")}. Review before relying on dependent metrics.`,
    );
  }

  const outputData: Record<string, unknown> = {
    aggregate: aggregatePl,
    base_pl: basePl,
    periods: periods.map((p) => ({ period: p.period, pl: p.pl })),
    granularity: modelDef.time_horizon.granularity,
    period_count: periods.length,
    simulation_mode: "formula_dag",
    ...(warnings.length > 0 ? { absurdity_warnings: warnings } : {}),
    ...(notices.length > 0 ? { notices } : {}),
  };
  if (warnings.length > 0) {
    logger.warn(`[Simulation] ${warnings.length} absurdity warning(s) generated`);
  }
  await storeAndComplete(scenarioId, outputData);

  return {
    pl: aggregatePl,
    variables: lastPeriodVars,
    periods,
    period_count: periods.length,
    granularity: modelDef.time_horizon.granularity,
    simulation_mode: "formula_dag",
    ...(warnings.length > 0 ? { absurdity_warnings: warnings } : {}),
    ...(notices.length > 0 ? { notices } : {}),
  };
}
