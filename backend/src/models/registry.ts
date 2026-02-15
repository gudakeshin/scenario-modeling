/**
 * Model registry: definitions loaded from external API or default stub.
 *
 * All base values, metric lists, and variable classifications are
 * DERIVED from the model definition — never hardcoded elsewhere.
 */

export interface ModelVariable {
  id: string;
  name: string;
  formula: string;
  dependencies: string[];
  /** Tags for classification: "input", "output", "pl_metric", etc. */
  tags?: string[];
}

export interface TimeHorizon {
  start: string;
  end: string;
  granularity: "monthly" | "quarterly";
}

export interface ModelDefinition {
  model_version: string;
  variables: ModelVariable[];
  time_horizon: TimeHorizon;
}

/** Default stub model for dev: simple P&L. */
export const DEFAULT_MODEL: ModelDefinition = {
  model_version: "v0",
  time_horizon: { start: "2024-Q1", end: "2024-Q4", granularity: "quarterly" },
  variables: [
    { id: "revenue", name: "Revenue", formula: "units_sold * unit_price", dependencies: ["units_sold", "unit_price"], tags: ["pl_metric", "output"] },
    { id: "units_sold", name: "Units Sold", formula: "1000", dependencies: [], tags: ["input", "percent_delta"] },
    { id: "unit_price", name: "Unit Price", formula: "50", dependencies: [], tags: ["input", "percent_delta"] },
    { id: "raw_material_cost", name: "Raw Material Cost", formula: "revenue * 0.25", dependencies: ["revenue"], tags: ["intermediate", "percent_delta"] },
    { id: "cogs", name: "COGS", formula: "raw_material_cost", dependencies: ["raw_material_cost"], tags: ["pl_metric", "output"] },
    { id: "gross_margin", name: "Gross Margin", formula: "revenue - cogs", dependencies: ["revenue", "cogs"], tags: ["pl_metric", "output"] },
    { id: "opex", name: "OpEx", formula: "revenue * 0.15", dependencies: ["revenue"], tags: ["pl_metric", "percent_delta"] },
    { id: "ebitda", name: "EBITDA", formula: "gross_margin - opex", dependencies: ["gross_margin", "opex"], tags: ["pl_metric", "output"] },
    { id: "net_income", name: "Net Income", formula: "ebitda", dependencies: ["ebitda"], tags: ["pl_metric", "output"] },
  ],
};

export async function getModelDefinition(version?: string): Promise<ModelDefinition> {
  const envUrl = process.env.MODEL_REGISTRY_URL;
  if (envUrl && version) {
    try {
      const res = await fetch(`${envUrl}/models/${version}`);
      if (res.ok) return (await res.json()) as ModelDefinition;
    } catch {
      // fallback
    }
  }
  return DEFAULT_MODEL;
}

// ── Derived helpers (single source of truth) ──

function topologicalSort(variables: ModelVariable[]): string[] {
  const order: string[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const byId = new Map(variables.map((v) => [v.id, v]));
  function visit(id: string) {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error(`Circular dependency: ${id}`);
    visiting.add(id);
    const v = byId.get(id);
    if (v) for (const d of v.dependencies) visit(d);
    visiting.delete(id);
    visited.add(id);
    order.push(id);
  }
  for (const v of variables) visit(v.id);
  return order;
}

function evaluateFormula(formula: string, ctx: Record<string, number>): number {
  let expr = formula.trim();
  for (const [k, v] of Object.entries(ctx)) {
    expr = expr.replace(new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g"), String(v));
  }
  if (!/^[\d\s+\-*/().]+$/.test(expr)) return 0;
  try {
    return new Function(`return (${expr})`)();
  } catch {
    return 0;
  }
}

/**
 * Compute the base case P&L from the model definition.
 * This is the SINGLE SOURCE OF TRUTH for base values —
 * no other file should hardcode base_pl.
 */
export async function computeBaseCase(version?: string): Promise<Record<string, number>> {
  const model = await getModelDefinition(version);
  const order = topologicalSort(model.variables);
  const ctx: Record<string, number> = {};
  for (const id of order) {
    const v = model.variables.find((x) => x.id === id);
    if (!v) continue;
    ctx[id] = evaluateFormula(v.formula, ctx);
  }
  return ctx;
}

/**
 * Get the list of P&L metric variable IDs from model tags.
 */
export function getPLMetrics(model: ModelDefinition): string[] {
  return model.variables.filter((v) => v.tags?.includes("pl_metric")).map((v) => v.id);
}

/**
 * Get the set of variables that accept percent-delta overrides.
 */
export function getPercentDeltaVars(model: ModelDefinition): Set<string> {
  return new Set(model.variables.filter((v) => v.tags?.includes("percent_delta")).map((v) => v.id));
}

/**
 * Get input variables (leaves with no dependencies) — for sensitivity analysis.
 */
export function getInputVariables(model: ModelDefinition): ModelVariable[] {
  return model.variables.filter((v) => v.dependencies.length === 0);
}

/**
 * Build a description of the model for LLM context.
 */
export function describeModelForLLM(model: ModelDefinition): string {
  const lines = [`Financial Model (${model.model_version})`, `Time: ${model.time_horizon.start} to ${model.time_horizon.end}`, "", "Variables:"];
  for (const v of model.variables) {
    const tags = v.tags?.length ? ` [${v.tags.join(", ")}]` : "";
    lines.push(`  - ${v.id} (${v.name}): ${v.formula}${tags}`);
  }
  return lines.join("\n");
}
