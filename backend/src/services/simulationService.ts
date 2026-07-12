import { pool } from "../db/index.js";
import { getModelDefinition, getPLMetrics } from "../models/registry.js";
import { CompiledModel, generatePeriodLabels } from "./expression.js";
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
import { config } from "../config.js";
import {
  aggregatePeriodPlDetailed,
  aggregateXlsxPeriodPl,
  hasPeriodGrowth,
  periodOverrides,
} from "./simulationAggregation.js";
import {
  hydrateScenarioContext,
  getScenarioContext,
  validateAgainstConstraints,
} from "./scenarioContextService.js";

export interface ScenarioParameterRow {
  mapped_variable_id: string;
  scenario_value: number;
  status: string;
}

/** Single-period P&L snapshot */
export interface PeriodResult {
  period: string;
  pl: Record<string, number>;
  variables: Record<string, number>;
}

export interface FormulaErrorMetric {
  metric_id: string;
  raw_value: unknown;
  reason: string;
}

export interface SimulationOutput {
  pl: Record<string, number>;
  variables: Record<string, number>;
  periods: PeriodResult[];
  period_count: number;
  granularity: "monthly" | "quarterly";
  simulation_mode: "formula_dag" | "xlsx_cell_graph" | "external_model";
  absurdity_warnings?: string[];
  notices?: string[];
  formula_error_metrics?: FormulaErrorMetric[];
  status?: "completed" | "failed";
  failure_reason?: string;
  dimensional?: {
    dimensions: Array<{ id: string; name: string; type: string }>;
    member_catalog: Record<string, Record<string, string>>;
    breakdowns: Record<string, Record<string, Record<string, number>>>;
  };
}

/** Core P&L metrics that must be finite for a successful run. */
export const CORE_OUTPUT_IDS = new Set([
  "revenue",
  "net_income",
  "net_profit",
  "ebitda",
  "ebit",
  "gross_profit",
]);

export class SimulationFiniteError extends Error {
  constructor(
    message: string,
    public formula_error_metrics: FormulaErrorMetric[],
  ) {
    super(message);
    this.name = "SimulationFiniteError";
  }
}

export class ConstraintViolationError extends Error {
  constructor(
    message: string,
    public violations: Array<{ lever: string; reason: string }>,
  ) {
    super(message);
    this.name = "ConstraintViolationError";
  }
}

function isFiniteNumber(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Copy finite metrics into `out`, listing non-finite ones in `errors`.
 */
export function collectFiniteMetrics(
  source: Record<string, number | undefined | null>,
  out: Record<string, number>,
  errors: FormulaErrorMetric[],
): { coreFailed: boolean } {
  let coreFailed = false;
  for (const [id, raw] of Object.entries(source)) {
    if (isFiniteNumber(raw)) {
      out[id] = round2(raw);
    } else if (raw !== undefined) {
      errors.push({
        metric_id: id,
        raw_value: raw,
        reason: raw == null ? "missing" : Number.isNaN(raw as number) ? "NaN" : "non_finite",
      });
      if (CORE_OUTPUT_IDS.has(id)) coreFailed = true;
    }
  }
  // Also flag missing core outputs that were expected in source keys
  for (const id of CORE_OUTPUT_IDS) {
    if (id in source && !isFiniteNumber(source[id]) && !errors.some((e) => e.metric_id === id)) {
      errors.push({ metric_id: id, raw_value: source[id], reason: "non_finite" });
      coreFailed = true;
    }
  }
  return { coreFailed };
}

async function storeFailed(
  scenarioId: string,
  outputData: Record<string, unknown>,
): Promise<void> {
  await pool.query(
    `INSERT INTO scenario_outputs (scenario_id, output_type, output_data) VALUES ($1, 'pl', $2)`,
    [scenarioId, JSON.stringify({ ...outputData, status: "failed" })],
  );
  await pool.query(
    `UPDATE scenarios SET status = 'failed', updated_at = NOW() WHERE scenario_id = $1`,
    [scenarioId],
  );
}

const SIMULATION_TIMEOUT_MS = Number(process.env.SIMULATION_TIMEOUT_MS) || 60_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

function absurdityWarnings(
  basePl: Record<string, number>,
  scenarioPl: Record<string, number>,
): string[] {
  const threshold = config.ABSURDITY_THRESHOLD_PCT ?? 200;
  const warnings: string[] = [];
  for (const [metric, scenarioVal] of Object.entries(scenarioPl)) {
    const baseVal = basePl[metric];
    if (baseVal == null || Math.abs(baseVal) <= 0.01) continue;
    const changePct = ((scenarioVal - baseVal) / Math.abs(baseVal)) * 100;
    if (Math.abs(changePct) > threshold) {
      warnings.push(
        `${metric} changed by ${changePct.toFixed(0)}% — this seems disproportionate to the scenario inputs. ` +
          `Base: ${baseVal.toLocaleString()}, Scenario: ${scenarioVal.toLocaleString()}`,
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

async function enforceConstraints(scenarioId: string, absolute: Record<string, number>): Promise<void> {
  const ctx = (await hydrateScenarioContext(scenarioId)) ?? getScenarioContext(scenarioId);
  const result = validateAgainstConstraints(absolute, ctx?.constraints ?? []);
  if (!result.ok) {
    throw new ConstraintViolationError(
      `Scenario violates constraints: ${result.violations.map((v) => v.reason).join("; ")}`,
      result.violations,
    );
  }
}

// ── Entry point ──

export async function runSimulation(scenarioId: string): Promise<SimulationOutput> {
  return withTimeout(_runSimulationDispatcher(scenarioId), SIMULATION_TIMEOUT_MS, "Simulation");
}

/**
 * Preview simulation without persisting outputs or changing scenario status.
 * Uses the same EvaluableModel path as production runs.
 */
export async function previewSimulationForScenario(
  scenarioId: string,
  overrideParams?: ScenarioOverride[],
): Promise<SimulationOutput> {
  const resolved = await getEvaluableModelForScenario(scenarioId);
  const overrides = overrideParams ?? (await loadScenarioOverrides(scenarioId));
  const { absolute } = resolveOverridesToAbsolute(resolved.model, overrides);
  await enforceConstraints(scenarioId, absolute);

  if (resolved.source === "external_model") {
    const model = resolved.model as DimensionalModel;
    const dimOverrides = toDimensionalOverrides(overrides);
    const baseResult = model.evaluateDimensional([]);
    const scenarioResult = model.evaluateDimensional(dimOverrides);
    const pl: Record<string, number> = {};
    const basePl: Record<string, number> = {};
    const errors: FormulaErrorMetric[] = [];
    collectFiniteMetrics(scenarioResult.totals, pl, errors);
    collectFiniteMetrics(baseResult.totals, basePl, errors);
    return {
      pl,
      variables: { ...pl },
      periods: [{ period: "Total", pl, variables: { ...pl } }],
      period_count: 1,
      granularity: "quarterly",
      simulation_mode: "external_model",
      ...(errors.length ? { formula_error_metrics: errors } : {}),
      status: "completed",
    };
  }

  if (resolved.source === "xlsx_cell_graph") {
    const runtime = resolved.model;
    const baseOut = runtime.evaluate({});
    const scenarioOut = runtime.evaluate(absolute);
    const pl: Record<string, number> = {};
    const errors: FormulaErrorMetric[] = [];
    const { coreFailed } = collectFiniteMetrics(
      Object.fromEntries(runtime.outputIds.map((id) => [id, scenarioOut[id]])),
      pl,
      errors,
    );
    if (coreFailed) {
      throw new SimulationFiniteError("Preview failed: core metrics non-finite", errors);
    }
    return {
      pl,
      variables: { ...pl },
      periods: [{ period: "FY", pl, variables: { ...pl } }],
      period_count: 1,
      granularity: "quarterly",
      simulation_mode: "xlsx_cell_graph",
      ...(errors.length ? { formula_error_metrics: errors } : {}),
      status: "completed",
    };
  }

  // formula path
  const model = resolved.model as CompiledModel;
  const out = model.evaluate(absolute);
  const base = model.baseValues();
  const pl: Record<string, number> = {};
  const errors: FormulaErrorMetric[] = [];
  collectFiniteMetrics(out, pl, errors);
  void base;
  return {
    pl,
    variables: { ...out },
    periods: [{ period: "Total", pl, variables: { ...out } }],
    period_count: 1,
    granularity: "quarterly",
    simulation_mode: "formula_dag",
    ...(errors.length ? { formula_error_metrics: errors } : {}),
    status: "completed",
  };
}

async function _runSimulationDispatcher(scenarioId: string): Promise<SimulationOutput> {
  const resolved = await getEvaluableModelForScenario(scenarioId);
  const overrides = await loadScenarioOverrides(scenarioId);
  const { absolute } = resolveOverridesToAbsolute(resolved.model, overrides);
  await enforceConstraints(scenarioId, absolute);

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
  const formulaErrors: FormulaErrorMetric[] = [];
  const scenarioCollect = collectFiniteMetrics(
    Object.fromEntries(model.outputIds.map((id) => [id, scenarioResult.totals[id]])),
    pl,
    formulaErrors,
  );
  collectFiniteMetrics(
    Object.fromEntries(model.outputIds.map((id) => [id, baseResult.totals[id]])),
    basePl,
    formulaErrors,
  );

  const variables: Record<string, number> = {};
  for (const input of model.inputs) {
    const v = scenarioResult.totals[input.id] ?? input.base;
    if (isFiniteNumber(v)) variables[input.id] = round2(v);
  }

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
        if (isFiniteNumber(v)) periodPl[id] = round2(v);
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

  const breakdowns: Record<string, Record<string, Record<string, number>>> = {};
  for (const metricId of model.outputIds) {
    breakdowns[metricId] = {};
    for (const dim of def.dimensions) {
      if (dim.type === "version") continue;
      const slice: Record<string, number> = {};
      const roots = dim.members.filter((m) => !m.parentId);
      const level1 =
        roots.length > 0
          ? dim.members.filter((m) => roots.some((r) => m.parentId === r.id) || roots.includes(m))
          : dim.members.filter((m) => m.isLeaf);
      for (const m of level1) {
        const v = scenarioResult.valueAt(metricId, { [dim.id]: m.id });
        if (isFiniteNumber(v)) slice[m.id] = round2(v);
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
  if (def.build_warnings?.length) notices.push(...def.build_warnings);

  if (scenarioCollect.coreFailed) {
    const outputData = {
      aggregate: pl,
      base_pl: basePl,
      periods: periods.map((p) => ({ period: p.period, pl: p.pl })),
      simulation_mode: "external_model",
      formula_error_metrics: formulaErrors,
      status: "failed",
      failure_reason: "core_metrics_non_finite",
    };
    await storeFailed(scenarioId, outputData);
    throw new SimulationFiniteError("Simulation failed: core P&L metrics are non-finite", formulaErrors);
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
    ...(formulaErrors.length > 0 ? { formula_error_metrics: formulaErrors } : {}),
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
    status: "completed",
    ...(warnings.length > 0 ? { absurdity_warnings: warnings } : {}),
    ...(notices.length > 0 ? { notices } : {}),
    ...(formulaErrors.length > 0 ? { formula_error_metrics: formulaErrors } : {}),
  };
}

// ── XLSX path ──

async function _runXlsxSimulation(
  scenarioId: string,
  resolved: ResolvedModel,
  overrides: ScenarioOverride[],
): Promise<SimulationOutput> {
  const runtime = resolved.model;
  const { absolute, unresolved } = resolveOverridesToAbsolute(runtime, overrides);

  // Prefer multi-period evaluation when the runtime supports it
  const evaluatePeriods =
    "evaluatePeriods" in runtime && typeof (runtime as { evaluatePeriods?: Function }).evaluatePeriods === "function"
      ? (runtime as {
          evaluatePeriods: (o: Record<string, number>) => Array<{ period: string; values: Record<string, number> }>;
        }).evaluatePeriods.bind(runtime)
      : null;

  const baseOut = runtime.evaluate({});
  const scenarioOut = runtime.evaluate(absolute);

  const pl: Record<string, number> = {};
  const basePl: Record<string, number> = {};
  const formulaErrors: FormulaErrorMetric[] = [];
  const scenarioCollect = collectFiniteMetrics(
    Object.fromEntries(runtime.outputIds.map((id) => [id, scenarioOut[id]])),
    pl,
    formulaErrors,
  );
  collectFiniteMetrics(
    Object.fromEntries(runtime.outputIds.map((id) => [id, baseOut[id]])),
    basePl,
    formulaErrors,
  );

  const variables: Record<string, number> = {};
  for (const input of runtime.inputs) {
    const v = scenarioOut[input.id] ?? input.base;
    if (isFiniteNumber(v)) variables[input.id] = round2(v);
    else {
      formulaErrors.push({
        metric_id: input.id,
        raw_value: v,
        reason: "non_finite",
      });
    }
  }

  const warnings = absurdityWarnings(basePl, pl);
  const notices = unresolvedNotices(unresolved);
  const runtimeErrors =
    "lastEvaluationErrors" in runtime &&
    Array.isArray((runtime as { lastEvaluationErrors: string[] }).lastEvaluationErrors)
      ? (runtime as { lastEvaluationErrors: string[] }).lastEvaluationErrors
      : [];
  if (runtimeErrors.length > 0) {
    notices.push(...runtimeErrors.map((e) => `Formula error: ${e}`));
    for (const e of runtimeErrors) {
      formulaErrors.push({ metric_id: "_runtime", raw_value: e, reason: "formula_error" });
    }
  }

  let periods: PeriodResult[] = [{ period: "FY", pl, variables }];
  if (evaluatePeriods) {
    try {
      const periodSlices = evaluatePeriods(absolute);
      if (periodSlices.length > 0) {
        periods = periodSlices.map((s) => {
          const periodPl: Record<string, number> = {};
          const pe: FormulaErrorMetric[] = [];
          collectFiniteMetrics(s.values, periodPl, pe);
          formulaErrors.push(...pe);
          return { period: s.period, pl: periodPl, variables: { ...periodPl } };
        });
        // Ratio-aware aggregate (margins/rates never summed across periods)
        if (periods.length > 1) {
          const { aggregate: agg, warnings: aggWarnings } = aggregateXlsxPeriodPl(
            periods,
            runtime.outputIds,
          );
          notices.push(...aggWarnings);
          Object.assign(pl, agg);
        }
      }
    } catch (e) {
      notices.push(`Multi-period evaluation failed: ${(e as Error).message}`);
    }
  }

  if (scenarioCollect.coreFailed) {
    const outputData = {
      aggregate: pl,
      base_pl: basePl,
      periods: periods.map((p) => ({ period: p.period, pl: p.pl })),
      simulation_mode: "xlsx_cell_graph",
      formula_error_metrics: formulaErrors,
      notices,
      status: "failed",
      failure_reason: "core_metrics_non_finite",
    };
    await storeFailed(scenarioId, outputData);
    throw new SimulationFiniteError("Simulation failed: core P&L metrics are non-finite", formulaErrors);
  }

  const outputData: Record<string, unknown> = {
    aggregate: pl,
    base_pl: basePl,
    periods: periods.map((p) => ({ period: p.period, pl: p.pl })),
    granularity: "quarterly",
    period_count: periods.length,
    simulation_mode: "xlsx_cell_graph",
    ...(warnings.length > 0 ? { absurdity_warnings: warnings } : {}),
    ...(notices.length > 0 ? { notices } : {}),
    ...(formulaErrors.length > 0 ? { formula_error_metrics: formulaErrors } : {}),
  };
  await storeAndComplete(scenarioId, outputData);

  return {
    pl,
    variables,
    periods,
    period_count: periods.length,
    granularity: "quarterly",
    simulation_mode: "xlsx_cell_graph",
    status: "completed",
    ...(warnings.length > 0 ? { absurdity_warnings: warnings } : {}),
    ...(notices.length > 0 ? { notices } : {}),
    ...(formulaErrors.length > 0 ? { formula_error_metrics: formulaErrors } : {}),
  };
}

// ── Formula-DAG path ──

async function _runFormulaSimulation(
  scenarioId: string,
  overrides: ScenarioOverride[],
): Promise<SimulationOutput> {
  const scenarioRes = await pool.query(
    "SELECT model_version_hash FROM scenarios WHERE scenario_id = $1",
    [scenarioId],
  );
  if (scenarioRes.rows.length === 0) throw new Error("Scenario not found");
  const modelVersion = scenarioRes.rows[0].model_version_hash;

  const modelDef = await getModelDefinition(modelVersion);
  if (!modelDef) throw new Error("No model found. Please build a model from your documents first.");
  const model = new CompiledModel(modelDef);
  const plMetricIds = getPLMetrics(modelDef);

  const { absolute, unresolved } = resolveOverridesToAbsolute(model, overrides);

  const baseCtx = model.baseValues();
  const periodLabels = generatePeriodLabels(modelDef.time_horizon);
  const useGrowth = hasPeriodGrowth(modelDef);

  const formulaErrors: FormulaErrorMetric[] = [];
  const periods: PeriodResult[] = periodLabels.map((label, t) => {
    const absForPeriod = useGrowth ? periodOverrides(modelDef, absolute, t, baseCtx) : absolute;
    const scenarioCtx = model.evaluate(absForPeriod);
    const periodPl: Record<string, number> = {};
    for (const id of plMetricIds) {
      const v = scenarioCtx[id];
      if (isFiniteNumber(v)) periodPl[id] = round2(v);
      else if (id in scenarioCtx) {
        formulaErrors.push({ metric_id: id, raw_value: v, reason: "non_finite" });
      }
    }
    return { period: label, pl: periodPl, variables: { ...scenarioCtx } };
  });

  const { aggregate: aggregatePl, warnings: aggWarnings } = aggregatePeriodPlDetailed(
    model,
    modelDef,
    periods,
    absolute,
  );
  const lastPeriodVars = periods.length > 0 ? periods[periods.length - 1].variables : {};

  const basePl: Record<string, number> = {};
  for (const id of plMetricIds) {
    const v = baseCtx[id];
    if (isFiniteNumber(v)) basePl[id] = round2(v);
  }
  const singlePeriodPl: Record<string, number> = periods[0]?.pl ?? {};
  const warnings = absurdityWarnings(basePl, singlePeriodPl);
  const notices = unresolvedNotices(unresolved);
  notices.push(...aggWarnings);

  const assumed = modelDef.variables.filter((v) => v.provenance === "assumed").map((v) => v.id);
  if (assumed.length > 0) {
    notices.push(
      `Model includes assumed-0 variables (not extracted from documents): ${assumed.join(", ")}. Review before relying on dependent metrics.`,
    );
  }

  const coreFailed = [...CORE_OUTPUT_IDS].some(
    (id) => plMetricIds.includes(id) && !isFiniteNumber(aggregatePl[id]),
  );
  if (coreFailed) {
    for (const id of CORE_OUTPUT_IDS) {
      if (plMetricIds.includes(id) && !isFiniteNumber(aggregatePl[id])) {
        formulaErrors.push({ metric_id: id, raw_value: aggregatePl[id], reason: "non_finite" });
      }
    }
    await storeFailed(scenarioId, {
      aggregate: aggregatePl,
      base_pl: basePl,
      formula_error_metrics: formulaErrors,
      status: "failed",
      failure_reason: "core_metrics_non_finite",
    });
    throw new SimulationFiniteError("Simulation failed: core P&L metrics are non-finite", formulaErrors);
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
    ...(formulaErrors.length > 0 ? { formula_error_metrics: formulaErrors } : {}),
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
    status: "completed",
    ...(warnings.length > 0 ? { absurdity_warnings: warnings } : {}),
    ...(notices.length > 0 ? { notices } : {}),
    ...(formulaErrors.length > 0 ? { formula_error_metrics: formulaErrors } : {}),
  };
}
