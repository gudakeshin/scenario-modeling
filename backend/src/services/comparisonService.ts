import { pool } from "../db/index.js";
import { computeBaseCase, getModelDefinition, getPLMetrics } from "../models/registry.js";

export interface ScenarioRef {
  scenario_id: string;
  name: string | null;
  nl_input: string;
  created_at: string;
}

export interface ComparisonRow {
  metric: string;
  base: number;
  scenarios: (ScenarioRef & { value: number; delta: number; delta_pct: number | null })[];
}

export interface ComparisonResult {
  scenarios: ScenarioRef[];
  metrics: ComparisonRow[];
  assumption_diff: {
    parameter: string;
    base_value: string;
    scenarios: (ScenarioRef & { value: string })[];
  }[];
  key_callouts: { label: string; base: number; scenario: number; delta: number; delta_pct: number | null }[];
}

export async function compareScenarios(scenarioIds: string[]): Promise<ComparisonResult> {
  if (scenarioIds.length < 1 || scenarioIds.length > 4) {
    throw new Error("Provide 1–4 scenario IDs to compare");
  }

  // Fetch outputs for each scenario
  const scenarioData: { id: string; name: string | null; nl_input: string; created_at: string; pl: Record<string, number> }[] = [];
  for (const id of scenarioIds) {
    const sRes = await pool.query("SELECT name, nl_input, created_at FROM scenarios WHERE scenario_id = $1", [id]);
    const oRes = await pool.query(
      "SELECT output_data FROM scenario_outputs WHERE scenario_id = $1 AND output_type = 'pl' ORDER BY created_at DESC LIMIT 1",
      [id]
    );
    const rawOutput = oRes.rows[0]?.output_data ?? {};
    const pl = rawOutput.aggregate ?? rawOutput;
    scenarioData.push({
      id,
      name: sRes.rows[0]?.name ?? null,
      nl_input: sRes.rows[0]?.nl_input ?? "",
      created_at: sRes.rows[0]?.created_at ?? "",
      pl,
    });
  }

  // Look up model from the first scenario's model_version_hash
  const modelRef = await pool.query("SELECT model_version_hash FROM scenarios WHERE scenario_id = $1", [scenarioIds[0]]);
  const modelHash = modelRef.rows[0]?.model_version_hash;
  const model = await getModelDefinition(modelHash);
  if (!model) return { scenarios: [], metrics: [], assumption_diff: [], key_callouts: [] };
  const baseCtx = await computeBaseCase(model);
  const metricKeys = getPLMetrics(model);

  const scenarioRefs: ScenarioRef[] = scenarioData.map((s) => ({
    scenario_id: s.id,
    name: s.name,
    nl_input: s.nl_input,
    created_at: s.created_at,
  }));

  const metrics: ComparisonRow[] = metricKeys.map((metric) => {
    const baseVal = baseCtx[metric] ?? 0;
    return {
      metric,
      base: Math.round(baseVal * 100) / 100,
      scenarios: scenarioData.map((s) => {
        const val = s.pl[metric] ?? 0;
        const delta = val - baseVal;
        return {
          scenario_id: s.id,
          name: s.name,
          nl_input: s.nl_input,
          created_at: s.created_at,
          value: val,
          delta: Math.round(delta * 100) / 100,
          delta_pct: baseVal !== 0 ? Math.round((delta / baseVal) * 10000) / 100 : null,
        };
      }),
    };
  });

  // Assumption diff
  const assumption_diff: ComparisonResult["assumption_diff"] = [];
  const allParams = new Map<string, Map<string, string>>();
  for (const s of scenarioData) {
    const pRes = await pool.query(
      "SELECT extracted_name, scenario_value, status FROM scenario_parameters WHERE scenario_id = $1",
      [s.id]
    );
    for (const p of pRes.rows) {
      if (!allParams.has(p.extracted_name)) allParams.set(p.extracted_name, new Map());
      allParams.get(p.extracted_name)!.set(s.id, `${p.scenario_value} (${p.status})`);
    }
  }
  for (const [param, vals] of allParams) {
    assumption_diff.push({
      parameter: param,
      base_value: "—",
      scenarios: scenarioData.map((s) => ({
        scenario_id: s.id,
        name: s.name,
        nl_input: s.nl_input,
        created_at: s.created_at,
        value: vals.get(s.id) ?? "—",
      })),
    });
  }

  // Key callouts (top metrics by absolute delta of first scenario)
  const first = scenarioData[0];
  const key_callouts = metricKeys
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
