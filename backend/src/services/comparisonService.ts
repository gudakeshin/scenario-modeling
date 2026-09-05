import { pool } from "../db/index.js";
import { computeBaseCase, getModelDefinition, getPLMetrics } from "../models/registry.js";
import { basePlFromOutput, resolveBasePl } from "./basePl.js";

export interface ScenarioRef {
  scenario_id: string;
  name: string | null;
  nl_input: string;
  created_at: string;
  /** False when the scenario has never been simulated — its "value" is a
   *  placeholder 0, not a real result, and callers must not read a delta
   *  off it as though the P&L actually collapsed to zero. */
  has_output?: boolean;
}

export interface ComparisonRow {
  metric: string;
  base: number;
  scenarios: (ScenarioRef & { value: number; delta: number; delta_pct: number | null; not_run?: boolean })[];
}

export interface ComparisonResult {
  scenarios: ScenarioRef[];
  metrics: ComparisonRow[];
  assumption_diff: {
    parameter: string;
    base_value: number | string;
    scenarios: (ScenarioRef & { value: string })[];
  }[];
  key_callouts: { label: string; base: number; scenario: number; delta: number; delta_pct: number | null }[];
}

/** Test helper: build comparison rows from in-memory outputs (no Postgres). */
export function compareFromOutputs(
  scenarioData: Array<{
    id: string;
    name: string | null;
    nl_input: string;
    created_at: string;
    pl: Record<string, number>;
    rawOutput: Record<string, unknown>;
  }>,
  _model: unknown,
  baseCtx: Record<string, number>,
  metricKeys: string[],
  _params: unknown[],
): ComparisonResult {
  void _model;
  void _params;
  const hasOutput = new Map(scenarioData.map((s) => [s.id, Object.keys(s.pl).length > 0]));
  const scenarioRefs: ScenarioRef[] = scenarioData.map((s) => ({
    scenario_id: s.id,
    name: s.name,
    nl_input: s.nl_input,
    created_at: s.created_at,
    has_output: hasOutput.get(s.id),
  }));
  const metrics: ComparisonRow[] = metricKeys.map((metric) => {
    const baseVal = baseCtx[metric] ?? 0;
    return {
      metric,
      base: Math.round(baseVal * 100) / 100,
      scenarios: scenarioData.map((s) => {
        const notRun = !hasOutput.get(s.id);
        const val = notRun ? 0 : s.pl[metric] ?? 0;
        const delta = notRun ? 0 : val - baseVal;
        return {
          scenario_id: s.id,
          name: s.name,
          nl_input: s.nl_input,
          created_at: s.created_at,
          value: val,
          delta: Math.round(delta * 100) / 100,
          delta_pct: notRun ? null : baseVal !== 0 ? Math.round((delta / baseVal) * 10000) / 100 : null,
          not_run: notRun,
        };
      }),
    };
  });
  return { scenarios: scenarioRefs, metrics, assumption_diff: [], key_callouts: [] };
}

export async function compareScenarios(scenarioIds: string[]): Promise<ComparisonResult> {
  if (scenarioIds.length < 1 || scenarioIds.length > 4) {
    throw new Error("Provide 1–4 scenario IDs to compare");
  }

  // Batched lookups — one query per table instead of N per scenario.
  const [scenariosRes, outputsRes, paramsRes] = await Promise.all([
    pool.query(
      "SELECT scenario_id, name, nl_input, created_at, model_version_hash FROM scenarios WHERE scenario_id = ANY($1::uuid[])",
      [scenarioIds],
    ),
    pool.query(
      `SELECT DISTINCT ON (scenario_id) scenario_id, output_data
       FROM scenario_outputs
       WHERE scenario_id = ANY($1::uuid[]) AND output_type = 'pl'
       ORDER BY scenario_id, created_at DESC`,
      [scenarioIds],
    ),
    pool.query(
      "SELECT scenario_id, extracted_name, mapped_variable_id, scenario_value, status FROM scenario_parameters WHERE scenario_id = ANY($1::uuid[])",
      [scenarioIds],
    ),
  ]);

  const scenarioRowById = new Map(scenariosRes.rows.map((r) => [r.scenario_id, r]));
  const outputByScenarioId = new Map(outputsRes.rows.map((r) => [r.scenario_id, r.output_data]));

  const scenarioData = scenarioIds.map((id) => {
    const row = scenarioRowById.get(id);
    const rawOutput = (outputByScenarioId.get(id) ?? {}) as Record<string, unknown>;
    const pl = (rawOutput.aggregate ?? rawOutput) as Record<string, number>;
    return {
      id,
      name: row?.name ?? null,
      nl_input: row?.nl_input ?? "",
      created_at: row?.created_at ?? "",
      pl,
      rawOutput,
      // A draft/never-simulated scenario has no scenario_outputs row at all —
      // distinct from one that ran and genuinely produced a zero. Comparing
      // against it must not read "every metric collapsed to 0 (-100%)".
      hasOutput: outputByScenarioId.has(id),
    };
  });

  // Look up model from the first scenario's model_version_hash
  const modelHash = scenarioRowById.get(scenarioIds[0])?.model_version_hash;
  const model = await getModelDefinition(modelHash);

  // A spreadsheet workspace still gets a ModelDefinition row in user_models —
  // a catalog snapshot for onboarding/labeling, never the thing that actually
  // ran. Its ids go through the same collision-disambiguation as the XLSX
  // runtime's variable list, but independently, so "india_branded_formulations"
  // there becomes "..._2" while the real simulation output keeps the bare id.
  // Trusting this catalog for metric keys on an XLSX scenario compares against
  // ids the real pl/base_pl never had, reading as "0 (-100%)" everywhere.
  const isXlsxComparison = scenarioData.some(
    (s) => (s.rawOutput as { simulation_mode?: string })?.simulation_mode === "xlsx_cell_graph",
  );

  // Prefer persisted base_pl (needed for XLSX where model is null) — read it
  // off a scenario that actually ran. scenarioData[0] may be a draft with no
  // output at all, which would otherwise fall through to the catalog model.
  const baseSource = scenarioData.find((s) => s.hasOutput) ?? scenarioData[0];
  let baseCtx = await resolveBasePl(
    baseSource?.rawOutput,
    isXlsxComparison ? null : model,
    baseSource?.id,
  );
  let metricKeys: string[];
  if (model && !isXlsxComparison) {
    metricKeys = getPLMetrics(model);
    if (Object.keys(baseCtx).length === 0) baseCtx = await computeBaseCase(model);
  } else {
    const keySet = new Set<string>();
    for (const s of scenarioData) {
      for (const k of Object.keys(s.pl)) keySet.add(k);
      const bp = basePlFromOutput(s.rawOutput);
      if (bp) for (const k of Object.keys(bp)) keySet.add(k);
    }
    metricKeys = [...keySet];
    if (Object.keys(baseCtx).length === 0) {
      baseCtx = basePlFromOutput(scenarioData[0]?.rawOutput) ?? {};
    }
  }

  if (metricKeys.length === 0 && Object.keys(baseCtx).length === 0) {
    return { scenarios: [], metrics: [], assumption_diff: [], key_callouts: [] };
  }

  const scenarioRefs: ScenarioRef[] = scenarioData.map((s) => ({
    scenario_id: s.id,
    name: s.name,
    nl_input: s.nl_input,
    created_at: s.created_at,
    has_output: s.hasOutput,
  }));

  const metrics: ComparisonRow[] = metricKeys.map((metric) => {
    const baseVal = baseCtx[metric] ?? 0;
    return {
      metric,
      base: Math.round(baseVal * 100) / 100,
      scenarios: scenarioData.map((s) => {
        const notRun = !s.hasOutput;
        const val = notRun ? 0 : s.pl[metric] ?? 0;
        const delta = notRun ? 0 : val - baseVal;
        return {
          scenario_id: s.id,
          name: s.name,
          nl_input: s.nl_input,
          created_at: s.created_at,
          value: val,
          delta: Math.round(delta * 100) / 100,
          delta_pct: notRun ? null : baseVal !== 0 ? Math.round((delta / baseVal) * 10000) / 100 : null,
          not_run: notRun,
        };
      }),
    };
  });

  // Assumption diff — base_value is the model's actual base for the
  // parameter's mapped variable (was hardcoded to "—" for every row).
  const assumption_diff: ComparisonResult["assumption_diff"] = [];
  const allParams = new Map<string, { variableId: string | null; values: Map<string, string> }>();
  for (const p of paramsRes.rows as Array<{
    scenario_id: string; extracted_name: string; mapped_variable_id: string | null; scenario_value: number; status: string;
  }>) {
    if (!allParams.has(p.extracted_name)) {
      allParams.set(p.extracted_name, { variableId: p.mapped_variable_id, values: new Map() });
    }
    allParams.get(p.extracted_name)!.values.set(p.scenario_id, `${p.scenario_value} (${p.status})`);
  }
  for (const [param, { variableId, values }] of allParams) {
    const baseValue = variableId && baseCtx[variableId] != null
      ? Math.round(baseCtx[variableId] * 100) / 100
      : "—";
    assumption_diff.push({
      parameter: param,
      base_value: baseValue,
      scenarios: scenarioData.map((s) => ({
        scenario_id: s.id,
        name: s.name,
        nl_input: s.nl_input,
        created_at: s.created_at,
        value: values.get(s.id) ?? "—",
      })),
    });
  }

  // Key callouts (top metrics by absolute delta of first scenario that has
  // actually been simulated — a draft scenario picked here would render
  // every callout as a fabricated 100% collapse).
  const first = scenarioData.find((s) => s.hasOutput) ?? scenarioData[0];
  const key_callouts = !first?.hasOutput
    ? []
    : metricKeys
    .map((m) => {
      const baseVal = baseCtx[m] ?? 0;
      const scenVal = first?.pl[m] ?? 0;
      const delta = scenVal - baseVal;
      return {
        label: m,
        base: Math.round(baseVal * 100) / 100,
        scenario: scenVal,
        delta: Math.round(delta * 100) / 100,
        delta_pct: baseVal !== 0 ? Math.round((delta / baseVal) * 10000) / 100 : null,
      };
    })
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, 4);

  return { scenarios: scenarioRefs, metrics, assumption_diff, key_callouts };
}
