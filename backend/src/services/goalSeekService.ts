/**
 * Goal seek — solve for an input lever value that yields a target metric.
 * Uses secant with bisection fallback; respects scenario constraints.
 */

import { pool } from "../db/index.js";
import { config } from "../config.js";
import type { EvaluableModel } from "./expression.js";
import {
  getEvaluableModelForScenario,
  loadScenarioOverrides,
  resolveOverridesToAbsolute,
} from "./modelResolver.js";
import {
  getScenarioContext,
  validateAgainstConstraints,
} from "./scenarioContextService.js";
import { pickDefaultTargetMetric } from "./metricTypes.js";

export interface GoalSeekRequest {
  target_metric?: string;
  target_value: number;
  variable_id: string;
  /** Optional search bracket. Defaults derived from current value. */
  low?: number;
  high?: number;
  tolerance?: number;
}

export interface GoalSeekResult {
  variable_id: string;
  target_metric: string;
  target_value: number;
  solved_value: number | null;
  achieved_metric: number | null;
  iterations: number;
  converged: boolean;
  diagnostics: {
    method: "secant" | "bisection" | "none";
    bracket?: [number, number];
    last_error?: number;
    constraint_violations?: Array<{ lever: string; reason: string }>;
    message?: string;
  };
}

class GoalSeekError extends Error {
  status = 422;
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function evaluateMetric(
  model: EvaluableModel,
  abs: Record<string, number>,
  metric: string,
): number {
  const out = model.evaluate(abs);
  if (!(metric in out)) {
    throw new GoalSeekError(
      `Unknown target metric '${metric}'. Available: ${model.outputIds.join(", ")}`,
    );
  }
  return out[metric] ?? 0;
}

/**
 * Pure goal-seek over an EvaluableModel. Exported for unit tests.
 */
export function computeGoalSeek(
  model: EvaluableModel,
  scenarioAbs: Record<string, number>,
  opts: {
    variableId: string;
    targetMetric: string;
    targetValue: number;
    low?: number;
    high?: number;
    tolerance?: number;
    maxIterations?: number;
    constraints?: import("./scenarioContextService.js").ScenarioConstraint[];
  },
): GoalSeekResult {
  const {
    variableId,
    targetValue,
    tolerance = 1e-4,
    maxIterations = config.GOAL_SEEK_MAX_ITERATIONS,
    constraints = [],
  } = opts;
  const targetMetric = pickDefaultTargetMetric(model.outputIds, opts.targetMetric);

  const input = model.inputs.find((i) => i.id === variableId);
  if (!input) {
    throw new GoalSeekError(
      `Unknown variable '${variableId}'. Available inputs: ${model.inputs.map((i) => i.id).join(", ")}`,
    );
  }

  const f = (x: number): number => {
    const abs = { ...scenarioAbs, [variableId]: x };
    return evaluateMetric(model, abs, targetMetric) - targetValue;
  };

  let x0 = scenarioAbs[variableId] ?? input.base;
  if (!Number.isFinite(x0)) x0 = 0;
  const span = Math.max(Math.abs(x0) * 0.5, Math.abs(targetValue) * 0.01, 1);
  let lo = opts.low ?? x0 - span * 2;
  let hi = opts.high ?? x0 + span * 2;
  if (lo > hi) [lo, hi] = [hi, lo];

  let iterations = 0;
  let method: GoalSeekResult["diagnostics"]["method"] = "none";
  let converged = false;
  let solved: number | null = null;
  let lastError = Infinity;

  // Expand bracket until sign change (limited attempts)
  let flo = f(lo);
  let fhi = f(hi);
  iterations += 2;
  for (let expand = 0; expand < 8 && flo * fhi > 0; expand++) {
    const mid = (lo + hi) / 2;
    const width = hi - lo;
    lo = mid - width;
    hi = mid + width;
    flo = f(lo);
    fhi = f(hi);
    iterations += 2;
  }

  if (flo * fhi > 0) {
    // Try secant from current point anyway
    method = "secant";
    let a = x0;
    let b = x0 === 0 ? 1 : x0 * 1.1;
    let fa = f(a);
    let fb = f(b);
    iterations += 2;
    for (let i = 0; i < maxIterations && iterations < maxIterations; i++) {
      if (Math.abs(fb - fa) < 1e-15) break;
      const next = b - fb * (b - a) / (fb - fa);
      if (!Number.isFinite(next)) break;
      a = b;
      fa = fb;
      b = next;
      fb = f(b);
      iterations++;
      lastError = Math.abs(fb);
      if (lastError <= tolerance) {
        solved = b;
        converged = true;
        break;
      }
    }
  } else {
    // Bisection (with optional secant acceleration)
    method = "bisection";
    let a = lo;
    let b = hi;
    let fa = flo;
    for (let i = 0; i < maxIterations && iterations < maxIterations; i++) {
      const mid = (a + b) / 2;
      const fm = f(mid);
      iterations++;
      lastError = Math.abs(fm);
      if (lastError <= tolerance || (b - a) / 2 <= tolerance) {
        solved = mid;
        converged = true;
        break;
      }
      if (fa * fm <= 0) {
        b = mid;
      } else {
        a = mid;
        fa = fm;
      }
    }
    if (!converged) {
      solved = (a + b) / 2;
      lastError = Math.abs(f(solved));
      iterations++;
      converged = lastError <= tolerance * 10;
      method = "bisection";
    }
  }

  let achieved: number | null = null;
  const constraintViolations: Array<{ lever: string; reason: string }> = [];

  if (solved != null && Number.isFinite(solved)) {
    solved = round6(solved);
    const abs = { ...scenarioAbs, [variableId]: solved };
    achieved = round6(evaluateMetric(model, abs, targetMetric));
    const validation = validateAgainstConstraints(abs, constraints);
    if (!validation.ok) {
      converged = false;
      for (const v of validation.violations) {
        constraintViolations.push({ lever: v.lever, reason: v.reason });
      }
    }
  }

  return {
    variable_id: variableId,
    target_metric: targetMetric,
    target_value: targetValue,
    solved_value: solved,
    achieved_metric: achieved,
    iterations,
    converged,
    diagnostics: {
      method,
      bracket: [lo, hi],
      last_error: Number.isFinite(lastError) ? round6(lastError) : undefined,
      ...(constraintViolations.length > 0 ? { constraint_violations: constraintViolations } : {}),
      ...(!converged && solved == null
        ? { message: "Could not find a root in the search bracket" }
        : {}),
      ...(constraintViolations.length > 0
        ? { message: "Solved value violates scenario constraints" }
        : {}),
    },
  };
}

export async function runGoalSeek(
  scenarioId: string,
  req: GoalSeekRequest,
): Promise<GoalSeekResult> {
  if (req.target_value == null || !Number.isFinite(req.target_value)) {
    throw new GoalSeekError("target_value is required and must be finite");
  }
  if (!req.variable_id) {
    throw new GoalSeekError("variable_id is required");
  }

  const resolved = await getEvaluableModelForScenario(scenarioId);
  const model = resolved.model;
  const overrides = await loadScenarioOverrides(scenarioId);
  const { absolute: scenarioAbs } = resolveOverridesToAbsolute(model, overrides);

  const ctx = getScenarioContext(scenarioId);
  const result = computeGoalSeek(model, scenarioAbs, {
    variableId: req.variable_id,
    targetMetric: req.target_metric || "net_income",
    targetValue: req.target_value,
    low: req.low,
    high: req.high,
    tolerance: req.tolerance,
    maxIterations: config.GOAL_SEEK_MAX_ITERATIONS,
    constraints: ctx?.constraints ?? [],
  });

  await pool.query(
    `INSERT INTO scenario_outputs (scenario_id, output_type, output_data) VALUES ($1, 'goal_seek', $2)`,
    [scenarioId, JSON.stringify(result)],
  );

  return result;
}
