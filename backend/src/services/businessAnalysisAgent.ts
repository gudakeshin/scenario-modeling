/**
 * Business Analyst Agent
 *
 * An LLM-powered analysis layer that answers "So what?" for the business.
 * Ingests all available scenario context — P&L, parameters, sensitivity,
 * Monte Carlo — and produces structured, actionable business insights.
 *
 * Output structure:
 *   - headline:         One-sentence "so what" (the single most important takeaway)
 *   - implications:     3-5 business implications (what this means)
 *   - risks:            Key risks and watch-outs
 *   - recommendations:  Prioritized action items (what to do next)
 *   - decision_context: Framing for decision-makers
 *   - confidence_note:  How much to trust this analysis
 */

import { z } from "zod";
import { getApiKey, callClaudeStructured } from "./llmClient.js";
import { pool } from "../db/index.js";
import { logger } from "../logger.js";
import {
  describeCostRevenueComposition,
  type ContextData,
} from "./contextEngine.js";

// ── Types ──

const evidenceRefSchema = z.object({
  metric_id: z.string().describe("Model variable id this claim is grounded in, e.g. 'net_income'"),
  value: z.number().describe("The computed value being cited"),
});

const remediationCtaSchema = z
  .enum(["open_doc_manager_model", "open_review", "refresh_analysis", "open_doc_manager"])
  .optional()
  .describe(
    "Optional in-app remediation deep-link: open_doc_manager_model (fix base P&L), open_review (re-run), refresh_analysis, open_doc_manager",
  );

const businessInsightSchema = z.object({
  headline: z.string(),
  implications: z.array(z.object({
    title: z.string(),
    detail: z.string(),
    severity: z.enum(["positive", "negative", "neutral"]),
    evidence: z.array(evidenceRefSchema).optional().describe("Metrics this implication is grounded in"),
  })).min(1),
  risks: z.array(z.object({
    risk: z.string(),
    likelihood: z.enum(["high", "medium", "low"]),
    mitigation: z.string(),
  })).min(1),
  recommendations: z.array(z.object({
    action: z.string(),
    priority: z.enum(["immediate", "short-term", "monitor"]),
    rationale: z.string(),
    owner: z.string().optional(),
    cta: remediationCtaSchema,
  })).min(1),
  decision_context: z.string(),
  confidence_note: z.string(),
  analysis_mode: z.enum(["standard", "integrity"]).optional(),
  mode_reasons: z.array(z.string()).optional(),
});

export type BusinessInsight = z.infer<typeof businessInsightSchema>;
export type RemediationCta = NonNullable<BusinessInsight["recommendations"][number]["cta"]>;

export type AnalysisMode = "standard" | "integrity";

export interface AnalysisModeResult {
  mode: AnalysisMode;
  reasons: string[];
}

/** Minimal P&L shape used by mode detection and grounding (no DB required). */
export interface PlModeInput {
  pl: Record<string, number>;
  base_pl: Record<string, number>;
  absurdity_warnings?: string[];
}

interface AnalysisContext extends PlModeInput {
  scenario_name: string | null;
  nl_input: string;
  parameters: { name: string; variable_id: string; value: number; status: string }[];
  sensitivity?: { target_metric: string; bars: { variable_name: string; spread: number; low_delta: number; high_delta: number }[] } | null;
  monte_carlo?: { metrics: Record<string, { p10: number; p50: number; p90: number; mean: number; stddev: number }> } | null;
  currency_symbol: string;
  period_count?: number;
  company_name?: string;
  industry?: string;
  business_model?: string;
  /** Revenue streams + cost/revenue line-item composition for grounded analysis. */
  cost_revenue_composition?: string;
  causal_chain?: Array<{ step: string; detail?: string; kind?: string }>;
  research_citations?: Array<{ source: string; snippet?: string; url?: string }>;
}

const BASE_NEAR_ZERO = 0.01;
const MATERIAL_SCENARIO_LEVEL = 1;

/**
 * Detect whether analysis must run in integrity mode (zero/missing baseline
 * or uninterpretable % deltas) vs standard impact analysis.
 */
export function detectAnalysisMode(input: PlModeInput): AnalysisModeResult {
  const reasons: string[] = [];
  const plEntries = Object.entries(input.pl).filter(([, v]) => typeof v === "number" && Number.isFinite(v));
  const baseEntries = Object.entries(input.base_pl).filter(([, v]) => typeof v === "number" && Number.isFinite(v));

  const materialScenario = plEntries.filter(([, v]) => Math.abs(v) >= MATERIAL_SCENARIO_LEVEL);
  const baseKeys = materialScenario.length > 0
    ? materialScenario.map(([k]) => k)
    : plEntries.map(([k]) => k);

  const basesForKeys = baseKeys.map((k) => input.base_pl[k] ?? 0);
  const allBasesNearZero =
    baseKeys.length > 0 &&
    basesForKeys.every((b) => Math.abs(b) <= BASE_NEAR_ZERO);

  const missingBase =
    baseEntries.length === 0 &&
    materialScenario.length > 0;

  if (missingBase) {
    reasons.push("Base P&L is missing while scenario P&L has material levels");
  } else if (allBasesNearZero && materialScenario.length > 0) {
    reasons.push("All base P&L values are ~0 while scenario levels are material — % deltas are uninterpretable");
  }

  const zeroBaseWithWarnings =
    (input.absurdity_warnings?.length ?? 0) > 0 &&
    plEntries.some(([k, v]) => Math.abs(v) >= MATERIAL_SCENARIO_LEVEL && Math.abs(input.base_pl[k] ?? 0) <= BASE_NEAR_ZERO);

  if (zeroBaseWithWarnings) {
    reasons.push("Absurdity warnings present with zero/near-zero base on key metrics");
  }

  if (reasons.length > 0) {
    return { mode: "integrity", reasons };
  }
  return { mode: "standard", reasons: [] };
}

const INTEGRITY_DIAGNOSIS_RE =
  /baseline|zero[\s-]?base|model[\s-]?setup|model[\s-]?integrity|not[\s-]+loaded|invalidat|uninterpretable|reload.*base|base[\s-]?case|setup[\s-]?flaw|zero[\s-]?baseline|n\/a\s*%|percentage[\s-]?change/i;

/** Deterministic check: integrity-mode analyses must diagnose the setup failure. */
export function analysisMentionsIntegrity(insight: BusinessInsight): boolean {
  const text = [
    insight.headline,
    insight.decision_context,
    insight.confidence_note,
    ...insight.implications.map((i) => `${i.title} ${i.detail}`),
    ...insight.recommendations.map((r) => `${r.action} ${r.rationale}`),
    ...insight.risks.map((r) => `${r.risk} ${r.mitigation}`),
  ].join(" ");
  return INTEGRITY_DIAGNOSIS_RE.test(text);
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: "$", EUR: "€", GBP: "£", INR: "₹", JPY: "¥", CNY: "¥",
  AUD: "A$", CAD: "C$", CHF: "CHF", SGD: "S$",
};

async function getCurrencyFromContext(scenarioId: string): Promise<string> {
  try {
    const r = await pool.query(
      `SELECT cc.context_data FROM company_context cc
       JOIN user_models um ON um.source_context_id = cc.context_id
       JOIN scenarios s ON s.model_version_hash = um.model_id::text
       WHERE s.scenario_id = $1 LIMIT 1`,
      [scenarioId]
    );
    const code = (r.rows[0]?.context_data as Record<string, unknown>)?.currency as string;
    return CURRENCY_SYMBOLS[code] || code || "$";
  } catch {
    return "$";
  }
}

async function getCompanyContextForScenario(scenarioId: string): Promise<{
  company_name?: string;
  industry?: string;
  business_model?: string;
  cost_revenue_composition?: string;
}> {
  try {
    const r = await pool.query(
      `SELECT cc.company_name, cc.industry, cc.context_data FROM company_context cc
       JOIN scenarios s ON s.workspace_id = cc.workspace_id
       WHERE s.scenario_id = $1 AND cc.status = 'active'
       ORDER BY cc.created_at DESC LIMIT 1`,
      [scenarioId],
    );
    if (!r.rows[0]) return {};
    const data = (r.rows[0].context_data || {}) as ContextData;
    return {
      company_name: r.rows[0].company_name || data.company_name || undefined,
      industry: r.rows[0].industry || data.industry || undefined,
      business_model: data.business_model || undefined,
      cost_revenue_composition: describeCostRevenueComposition(data) || undefined,
    };
  } catch {
    return {};
  }
}

// ── Data loader ──

async function loadAnalysisContext(
  scenarioId: string,
  extras?: {
    causal_chain?: AnalysisContext["causal_chain"];
    research_citations?: AnalysisContext["research_citations"];
  },
): Promise<AnalysisContext> {
  const sRes = await pool.query("SELECT name, nl_input FROM scenarios WHERE scenario_id = $1", [scenarioId]);
  if (sRes.rows.length === 0) throw new Error("Scenario not found");

  const pRes = await pool.query(
    "SELECT extracted_name, mapped_variable_id, scenario_value, status FROM scenario_parameters WHERE scenario_id = $1 AND status != 'rejected'",
    [scenarioId]
  );

  // Latest P&L output
  const plRes = await pool.query(
    "SELECT output_data FROM scenario_outputs WHERE scenario_id = $1 AND output_type = 'pl' ORDER BY created_at DESC LIMIT 1",
    [scenarioId]
  );
  const rawPl = plRes.rows[0]?.output_data ?? {};
  const absurdity_warnings: string[] = rawPl.absurdity_warnings ?? [];

  // Use single-period P&L for analysis (avoids comparing 8-quarter aggregate against 1-quarter base)
  const periods = rawPl.periods ?? [];
  const basePeriods = Array.isArray(rawPl.base_periods) ? rawPl.base_periods : [];
  const pl: Record<string, number> = periods.length > 0
    ? periods[0].pl
    : (rawPl.aggregate ?? rawPl);
  const periodCount = rawPl.period_count ?? 1;

  // Latest sensitivity output
  const sensRes = await pool.query(
    "SELECT output_data FROM scenario_outputs WHERE scenario_id = $1 AND output_type = 'sensitivity' ORDER BY created_at DESC LIMIT 1",
    [scenarioId]
  );
  const sensitivity = sensRes.rows[0]?.output_data ?? null;

  // Latest Monte Carlo output
  const mcRes = await pool.query(
    "SELECT output_data FROM scenario_outputs WHERE scenario_id = $1 AND output_type = 'monte_carlo' ORDER BY created_at DESC LIMIT 1",
    [scenarioId]
  );
  const monte_carlo = mcRes.rows[0]?.output_data ?? null;

  // Get model from scenario's model_version_hash
  const modelRef = await pool.query("SELECT model_version_hash FROM scenarios WHERE scenario_id = $1", [scenarioId]);
  const modelHash = modelRef.rows[0]?.model_version_hash;
  const { getModelDefinition: getModel } = await import("../models/registry.js");
  const { resolveBasePl } = await import("./basePl.js");
  const model = await getModel(modelHash);
  // When analysis uses periods[0].pl as scenario, prefer matching base_periods[0].pl
  // so base and scenario share the same period granularity (multi-period models).
  let base_pl: Record<string, number>;
  const basePeriod0 = basePeriods[0]?.pl;
  if (periods.length > 0 && basePeriod0 && typeof basePeriod0 === "object") {
    base_pl = {};
    for (const [k, v] of Object.entries(basePeriod0 as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v)) base_pl[k] = Math.round(v * 100) / 100;
    }
    if (Object.keys(base_pl).length === 0) {
      base_pl = await resolveBasePl(rawPl, model, scenarioId);
    }
  } else {
    base_pl = await resolveBasePl(rawPl, model, scenarioId);
  }

  const currency_symbol = await getCurrencyFromContext(scenarioId);
  const company = await getCompanyContextForScenario(scenarioId);

  return {
    scenario_name: sRes.rows[0].name,
    nl_input: sRes.rows[0].nl_input,
    pl,
    base_pl,
    currency_symbol,
    absurdity_warnings: absurdity_warnings.length > 0 ? absurdity_warnings : undefined,
    period_count: periodCount,
    parameters: pRes.rows.map((r: { extracted_name: string; mapped_variable_id: string; scenario_value: number; status: string }) => ({
      name: r.extracted_name,
      variable_id: r.mapped_variable_id,
      value: Number(r.scenario_value),
      status: r.status,
    })),
    sensitivity,
    monte_carlo,
    ...company,
    causal_chain: extras?.causal_chain,
    research_citations: extras?.research_citations,
  };
}

// ── Heuristic fallback (no LLM) ──

function generateIntegrityFallback(ctx: AnalysisContext, mode: AnalysisModeResult): BusinessInsight {
  const c = ctx.currency_symbol;
  const leverSummary = ctx.parameters.length > 0
    ? ctx.parameters.map((p) => `${p.name}=${p.value}%`).join(", ")
    : "stated scenario levers";

  const levelLines = Object.entries(ctx.pl)
    .filter(([, v]) => typeof v === "number" && Math.abs(v) >= MATERIAL_SCENARIO_LEVEL)
    .slice(0, 4);

  const implications: BusinessInsight["implications"] = [
    {
      title: "Zero/missing baseline invalidates all percentage-change metrics",
      detail: `${mode.reasons[0] || "Base P&L is ~0"}. Reload prior-quarter actuals or approved budget as base case before interpreting impact.`,
      severity: "negative",
    },
    {
      title: "Scenario absolute levels are not proven net impact",
      detail: levelLines.length > 0
        ? `Scenario shows ${levelLines.map(([k, v]) => `${k}=${c}${v.toLocaleString()}`).join("; ")} — cite only as levels, not as war/shock impact vs base.`
        : "Scenario P&L levels exist but cannot be compared to a valid baseline.",
      severity: "negative",
      evidence: levelLines.map(([metric_id, value]) => ({ metric_id, value })),
    },
    {
      title: "Preparedness should follow assumption levers, not bogus deltas",
      detail: `Use levers (${leverSummary}) for qualitative stress-tests and dual-sourcing plans; freeze delta-based decisions until baseline is fixed.`,
      severity: "neutral",
    },
  ];

  return {
    headline: "Model baseline missing/zero — halt delta-based decisions until base P&L is reloaded and re-run",
    implications,
    risks: [
      {
        risk: "Model integrity failure: percentage changes and absurd swings are artifacts of zero-baseline math",
        likelihood: "high",
        mitigation: "FP&A must reload a valid base-case P&L and re-run the scenario; freeze strategic decisions on deltas until verified.",
      },
      {
        risk: `Geopolitical or shock outcomes may exceed modeled levers (${leverSummary})`,
        likelihood: "medium",
        mitigation: "Strategy to run a severe-disruption war-game using lever magnitudes as a floor, not a ceiling.",
      },
    ],
    recommendations: [
      {
        action: "Fix or load a valid base-case P&L in Document Manager (Model tab), then mark model validated",
        priority: "immediate",
        rationale: "Zero-baseline P&L renders percentage changes meaningless; restore model credibility before circulating results.",
        owner: "FP&A",
        cta: "open_doc_manager_model",
      },
      {
        action: "Re-approve parameters and re-run this scenario once the baseline is non-zero",
        priority: "immediate",
        rationale: "Only a fresh run against a valid base produces interpretable net-impact deltas.",
        owner: "FP&A",
        cta: "open_review",
      },
      {
        action: "Convene cross-functional stress-test using stated assumption levers as planning inputs",
        priority: "short-term",
        rationale: "Without a valid baseline, leadership still needs a qualitative playbook tied to the scenario assumptions.",
        owner: "Strategy",
      },
    ],
    decision_context:
      `Decision framing: analysis mode is integrity (${mode.reasons.join("; ")}). Do not treat scenario-vs-base percentages as business impact. Act on model repair first, then qualitative preparedness from levers (${leverSummary}).`,
    confidence_note:
      "CRITICAL CAVEAT: Base P&L is missing or ~0, so scenario deltas are uninterpretable. Recommendations focus on model repair and qualitative preparedness. AI-generated analysis — validate with domain experts.",
    analysis_mode: "integrity",
    mode_reasons: mode.reasons,
  };
}

function generateFallbackAnalysis(ctx: AnalysisContext): BusinessInsight {
  const mode = detectAnalysisMode(ctx);
  if (mode.mode === "integrity") {
    return generateIntegrityFallback(ctx, mode);
  }

  const c = ctx.currency_symbol;
  const deltas: { metric: string; base: number; scenario: number; delta: number; pct: number }[] = [];
  for (const [metric, scenarioVal] of Object.entries(ctx.pl)) {
    const baseVal = ctx.base_pl[metric] ?? 0;
    const delta = scenarioVal - baseVal;
    const pct = baseVal !== 0 ? (delta / baseVal) * 100 : 0;
    deltas.push({ metric, base: baseVal, scenario: scenarioVal, delta, pct });
  }
  deltas.sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct));

  const topMover = deltas[0];
  const netIncome = deltas.find((d) => d.metric === "net_income");
  const ebitda = deltas.find((d) => d.metric === "ebitda");

  const direction = (netIncome?.delta ?? 0) >= 0 ? "positive" : "negative";
  const headline = netIncome
    ? `This scenario has a net ${direction} impact of ${c}${Math.abs(netIncome.delta).toLocaleString()} (${netIncome.pct >= 0 ? "+" : ""}${netIncome.pct.toFixed(1)}%) on net income, driven primarily by changes in ${topMover?.metric?.replace(/_/g, " ") || "key drivers"}.`
    : `Scenario "${ctx.nl_input}" has been analyzed. Review the implications below.`;

  const implications: BusinessInsight["implications"] = [];
  for (const d of deltas.slice(0, 4)) {
    const sev: "positive" | "negative" | "neutral" = d.pct > 2 ? "positive" : d.pct < -2 ? "negative" : "neutral";
    const label = d.metric.replace(/_/g, " ");
    implications.push({
      title: `${label} ${d.delta >= 0 ? "increases" : "decreases"} by ${Math.abs(d.pct).toFixed(1)}%`,
      detail: `${label} moves from ${c}${d.base.toLocaleString()} to ${c}${d.scenario.toLocaleString()} (${d.delta >= 0 ? "+" : "-"}${c}${Math.abs(d.delta).toLocaleString()}).${
        Math.abs(d.pct) > 10 ? " This is a material change that warrants close attention." : ""
      }`,
      severity: sev,
      evidence: [{ metric_id: d.metric, value: d.scenario }],
    });
  }

  // Risks
  const risks: BusinessInsight["risks"] = [];
  const negativeDeltas = deltas.filter((d) => d.pct < -2);
  if (negativeDeltas.length > 0) {
    risks.push({
      risk: `Margin compression: ${negativeDeltas.map((d) => d.metric.replace(/_/g, " ")).join(", ")} are under pressure`,
      likelihood: Math.abs(negativeDeltas[0].pct) > 10 ? "high" : "medium",
      mitigation: "Review cost structure and pricing strategy. Consider hedging or renegotiating supplier contracts.",
    });
  }

  if (ctx.sensitivity?.bars && ctx.sensitivity.bars.length > 0) {
    const topSensitive = ctx.sensitivity.bars[0];
    risks.push({
      risk: `High sensitivity to ${topSensitive.variable_name} — a ±swing produces ${c}${topSensitive.spread.toLocaleString()} variation`,
      likelihood: "medium",
      mitigation: `Develop contingency plans for ${topSensitive.variable_name} volatility. Consider scenario planning for best/worst cases.`,
    });
  }

  if (ctx.monte_carlo?.metrics) {
    const niMc = ctx.monte_carlo.metrics["net_income"];
    if (niMc) {
      const range = niMc.p90 - niMc.p10;
      const rangeAsPct = niMc.mean !== 0 ? (range / niMc.mean) * 100 : 0;
      if (rangeAsPct > 20) {
        risks.push({
          risk: `Wide outcome uncertainty: P10-P90 range for net income is ${c}${range.toLocaleString()} (${rangeAsPct.toFixed(0)}% of mean)`,
          likelihood: "medium",
          mitigation: "The wide confidence band suggests multiple outcomes are plausible. Consider phased investment or real-options approach.",
        });
      }
    }
  }

  if (risks.length === 0) {
    risks.push({
      risk: "Assumption accuracy — scenario relies on estimated parameter values",
      likelihood: "medium",
      mitigation: "Validate key assumptions with market data and domain experts before committing to decisions.",
    });
  }

  // Recommendations
  const recommendations: BusinessInsight["recommendations"] = [];

  if (netIncome && netIncome.delta > 0) {
    recommendations.push({
      action: "Proceed with scenario — the expected impact is net positive",
      priority: "short-term",
      rationale: `Net income improves by ${c}${netIncome.delta.toLocaleString()}. Validate assumptions and develop an implementation timeline.`,
      owner: "FP&A / Strategy",
    });
  } else if (netIncome && netIncome.delta < 0) {
    recommendations.push({
      action: "Develop mitigation plan before proceeding",
      priority: "immediate",
      rationale: `Net income declines by ${c}${Math.abs(netIncome.delta).toLocaleString()}. Identify offsetting cost savings or revenue upside.`,
      owner: "FP&A / Operations",
    });
  }

  if (ctx.parameters.length > 0) {
    const paramNames = ctx.parameters.map((p) => p.name).join(", ");
    recommendations.push({
      action: `Validate key assumptions (${paramNames}) with latest market data`,
      priority: "immediate",
      rationale: "Scenario outcomes are only as reliable as the input assumptions. Cross-reference with procurement, sales, and market intelligence.",
      owner: "Business Unit Leads",
    });
  }

  if (ctx.sensitivity?.bars && ctx.sensitivity.bars.length > 0) {
    const topVar = ctx.sensitivity.bars[0].variable_name;
    recommendations.push({
      action: `Establish monitoring dashboard for ${topVar}`,
      priority: "short-term",
      rationale: `${topVar} has the highest impact on outcomes. Early warning signals enable faster response.`,
      owner: "FP&A",
    });
  }

  recommendations.push({
    action: "Run Monte Carlo simulation to quantify outcome probability",
    priority: ctx.monte_carlo ? "monitor" : "short-term",
    rationale: ctx.monte_carlo
      ? "Monte Carlo results are available — review the P10/P90 range to understand worst/best case."
      : "Probabilistic analysis provides confidence intervals that deterministic scenarios cannot.",
    owner: "Analytics",
  });

  // Decision context
  const ebitdaPct = ebitda ? `EBITDA ${ebitda.pct >= 0 ? "+" : ""}${ebitda.pct.toFixed(1)}%` : "";
  const niPct = netIncome ? `Net Income ${netIncome.pct >= 0 ? "+" : ""}${netIncome.pct.toFixed(1)}%` : "";
  const decision_context =
    `**Decision framing:** This scenario ("${ctx.nl_input}") results in ${[ebitdaPct, niPct].filter(Boolean).join(", ")}. ` +
    `${direction === "positive"
      ? "The overall trajectory is favorable, but execution risk remains. Consider this a 'go' signal with guardrails."
      : "The trajectory is challenging. Before proceeding, the team should identify at least 2-3 offsetting levers and define clear go/no-go thresholds."
    }`;

  // Confidence note
  const hasSensitivity = !!ctx.sensitivity;
  const hasMC = !!ctx.monte_carlo;
  const dataRichness = [hasSensitivity && "sensitivity analysis", hasMC && "Monte Carlo simulation"].filter(Boolean);
  const confidence_note = dataRichness.length > 0
    ? `This analysis incorporates ${dataRichness.join(" and ")} data, providing higher confidence in the conclusions. AI-generated analysis — validate with domain experts.`
    : `This analysis is based on deterministic scenario results only. Running sensitivity and Monte Carlo analyses would strengthen confidence. AI-generated analysis — validate with domain experts.`;

  return { headline, implications, risks, recommendations, decision_context, confidence_note };
}

// ── LLM-powered analysis ──

const SYSTEM_PROMPT = `You are a senior business strategy analyst. Given financial scenario data, you produce structured "So What?" analysis using the provided tool.

Rules:
- implications: 3-5 items, focus on BUSINESS impact not just numbers. Each implication that cites a number MUST include an "evidence" entry with the exact metric_id and value from the CANONICAL METRICS / P&L data provided — never cite a number that isn't in the data you were given.
- risks: 2-4 items, each with a specific mitigation action
- recommendations: 3-5 items, ordered by priority. Each must be CONCRETE and ACTIONABLE (not "consider" or "think about" — use "do X", "establish Y", "convene Z")
- Always ask "so what does this mean for the business?" — don't just restate the numbers
- Recommendations should name an owner (FP&A, Operations, Sales, Strategy, CEO, etc.)
- The headline should be something a CEO can read in 5 seconds and know the key decision
- End confidence_note with: "AI-generated analysis — validate with domain experts."
- When ANALYSIS MODE is integrity: follow the INTEGRITY MODE rules in the user message exactly.`;

const INTEGRITY_MODE_RULES = `## ANALYSIS MODE: integrity (MANDATORY)

The baseline is missing or ~0 (or % deltas are otherwise uninterpretable). Produce a useful gate-clearable analysis:

1. Headline MUST lead with model-setup / baseline failure and say not to decide on deltas until base P&L is reloaded and re-run.
2. Implications MUST cover: (a) zero/missing baseline invalidates %, (b) scenario absolute levels may be cited only with evidence — never as proven net impact, (c) do NOT frame "healthy margin", "revenue intact", or "resilience" as if compared to base.
3. Severity: integrity issues = negative; preparedness items = neutral. Never use positive for unverifiable resilience.
4. Risks/recommendations: (1) fix baseline + re-run first; then qualitative stress-test / dual-source / reserve actions tied to ASSUMPTION LEVERS, not to bogus % deltas.
5. Cite numbers ONLY from the CANONICAL METRICS table below — copy values exactly into evidence[]. For zero-baseline claims use the **base** column (0); for absolute scenario levels use the **scenario** column. Never put scenario levels into evidence when arguing the base is zero.
6. Treat any ±200% / n/a% swings as math artifacts, not business outcomes.
7. Qualitative preparedness numbers (timeline years, contingency ₹ amounts, user % ranges like 25–50%) do NOT need evidence[] — only model metric citations do.`;

function buildCanonicalMetricsTable(ctx: AnalysisContext): string[] {
  const c = ctx.currency_symbol;
  const lines = ["## CANONICAL METRICS (cite ONLY these exact values)", "metric_id | base | scenario"];
  const keys = new Set([...Object.keys(ctx.pl), ...Object.keys(ctx.base_pl)]);
  for (const metric of keys) {
    if (metric === "periods" || metric === "aggregate" || metric === "absurdity_warnings" || metric === "base_pl" || metric === "period_count") {
      continue;
    }
    const scenario = ctx.pl[metric];
    const base = ctx.base_pl[metric] ?? 0;
    if (typeof scenario !== "number" || !Number.isFinite(scenario)) continue;
    lines.push(`- ${metric}: base=${c}${base} scenario=${c}${scenario}`);
  }
  return lines;
}

function buildUserPrompt(ctx: AnalysisContext): string {
  const c = ctx.currency_symbol;
  const mode = detectAnalysisMode(ctx);
  const parts = [
    `## Scenario: "${ctx.nl_input}"`,
    `Name: ${ctx.scenario_name || "(unnamed)"}`,
    `## ANALYSIS MODE: ${mode.mode}`,
    ...(mode.reasons.length > 0 ? mode.reasons.map((r) => `- Reason: ${r}`) : []),
    ctx.company_name ? `Company: ${ctx.company_name}` : "",
    ctx.industry ? `Industry: ${ctx.industry}` : "",
    ctx.business_model ? `Business model: ${ctx.business_model}` : "",
    ctx.cost_revenue_composition || "",
    ctx.period_count ? `Periods: ${ctx.period_count} quarters` : "",
    "",
    "## Assumptions Changed",
    ...ctx.parameters.map((p) => `- ${p.name} (${p.variable_id}): ${p.value}% [${p.status}]`),
    "",
    ...buildCanonicalMetricsTable(ctx),
    "",
    "## P&L Impact Per Period (Base → Scenario, single quarter)",
  ];

  if (mode.mode === "integrity") {
    parts.push(INTEGRITY_MODE_RULES, "");
  }

  for (const [metric, val] of Object.entries(ctx.pl)) {
    if (typeof val !== "number" || !Number.isFinite(val)) continue;
    const base = ctx.base_pl[metric] ?? 0;
    const delta = val - base;
    const pct = Math.abs(base) > BASE_NEAR_ZERO ? ((delta / base) * 100).toFixed(1) : "n/a";
    parts.push(`- ${metric}: ${c}${base.toLocaleString()} → ${c}${val.toLocaleString()} (${delta >= 0 ? "+" : "-"}${c}${Math.abs(delta).toLocaleString()}, ${pct}%)`);
  }

  if (ctx.causal_chain && ctx.causal_chain.length > 0) {
    parts.push("", "## Causal Chain (from scenario reasoning agent)");
    for (const step of ctx.causal_chain) {
      parts.push(`- [${step.kind || "other"}] ${step.step}${step.detail ? `: ${step.detail}` : ""}`);
    }
  }

  if (ctx.research_citations && ctx.research_citations.length > 0) {
    parts.push("", "## Research Citations");
    for (const cite of ctx.research_citations) {
      parts.push(`- ${cite.source}${cite.snippet ? `: ${cite.snippet}` : ""}${cite.url ? ` (${cite.url})` : ""}`);
    }
  }

  if (ctx.sensitivity?.bars && ctx.sensitivity.bars.length > 0) {
    parts.push("", "## Sensitivity Analysis (highest-impact variables)");
    for (const bar of ctx.sensitivity.bars.slice(0, 5)) {
      parts.push(`- ${bar.variable_name}: spread ${c}${bar.spread.toLocaleString()} (low: ${bar.low_delta >= 0 ? "+" : "-"}${c}${Math.abs(bar.low_delta).toLocaleString()}, high: +${c}${bar.high_delta.toLocaleString()})`);
    }
  }

  if (ctx.monte_carlo?.metrics) {
    parts.push("", "## Monte Carlo Results (probabilistic)");
    for (const [metric, data] of Object.entries(ctx.monte_carlo.metrics)) {
      parts.push(`- ${metric}: P10=${c}${data.p10.toLocaleString()} | P50=${c}${data.p50.toLocaleString()} | P90=${c}${data.p90.toLocaleString()} (stddev: ${c}${data.stddev.toLocaleString()})`);
    }
  }

  if (ctx.absurdity_warnings && ctx.absurdity_warnings.length > 0) {
    parts.push("", "## ⚠ ABSURDITY WARNINGS (from simulation validation)");
    for (const w of ctx.absurdity_warnings) {
      parts.push(`- ${w}`);
    }
    if (mode.mode === "integrity") {
      parts.push("", "NOTE: Treat these as artifacts of broken baseline math. Diagnose setup failure; do not treat them as real business outcomes.");
    } else {
      parts.push("", "NOTE: The simulation flagged potentially unrealistic results. Your analysis MUST acknowledge these warnings, explain possible causes (e.g. compounding effects, formula issues), and caveat any conclusions built on these numbers.");
    }
  }

  parts.push("", "Produce your structured business analysis focusing on 'So what does this mean?' and 'What should we do next?'");
  return parts.filter((p, i, arr) => !(p === "" && arr[i - 1] === "")).join("\n");
}

function systemPromptForMode(mode: AnalysisMode): string {
  if (mode === "integrity") {
    return SYSTEM_PROMPT + "\n\nYou are in INTEGRITY MODE. Lead with baseline/setup failure; preparedness must be qualitative and lever-based; never claim proven net impact from deltas. Tag the first remediation recommendation with cta=\"open_doc_manager_model\" and the re-run step with cta=\"open_review\" when applicable.";
  }
  return SYSTEM_PROMPT;
}

/**
 * Attach analysis_mode and ensure integrity-mode recs have actionable in-app CTAs.
 */
export function attachRemediationMeta(
  insight: BusinessInsight,
  mode: AnalysisModeResult,
): BusinessInsight {
  const withMode: BusinessInsight = {
    ...insight,
    analysis_mode: mode.mode,
    mode_reasons: mode.reasons.length > 0 ? mode.reasons : insight.mode_reasons,
  };

  if (mode.mode !== "integrity") return withMode;

  let hasModelCta = false;
  let hasReviewCta = false;
  const recommendations = withMode.recommendations.map((r) => {
    if (r.cta === "open_doc_manager_model" || r.cta === "open_doc_manager") hasModelCta = true;
    if (r.cta === "open_review") hasReviewCta = true;
    if (r.cta) return r;
    const text = `${r.action} ${r.rationale}`.toLowerCase();
    if (/reload|baseline|base[\s-]?p&?l|base case|model setup|document manager|validate|fix.*model/.test(text)) {
      hasModelCta = true;
      return { ...r, cta: "open_doc_manager_model" as const };
    }
    if (/re-?run|re-?approve|review param|simulate again/.test(text)) {
      hasReviewCta = true;
      return { ...r, cta: "open_review" as const };
    }
    return r;
  });

  if (!hasModelCta) {
    recommendations.unshift({
      action: "Open Document Manager → Model and load/fix a non-zero base-case P&L",
      priority: "immediate",
      rationale: "Integrity gate: deltas are uninterpretable until baseline actuals or budget are restored.",
      owner: "FP&A",
      cta: "open_doc_manager_model",
    });
  }
  if (!hasReviewCta) {
    recommendations.splice(1, 0, {
      action: "After baseline is fixed: Review Parameters → Approve & Run, then refresh So What?",
      priority: "immediate",
      rationale: "Re-run produces valid scenario-vs-base deltas for decision-making.",
      owner: "FP&A",
      cta: "open_review",
    });
  }

  return { ...withMode, recommendations };
}

export async function generateBusinessAnalysis(
  scenarioId: string,
  extras?: {
    causal_chain?: AnalysisContext["causal_chain"];
    research_citations?: AnalysisContext["research_citations"];
  },
): Promise<BusinessInsight> {
  const ctx = await loadAnalysisContext(scenarioId, extras);
  const mode = detectAnalysisMode(ctx);

  if (!getApiKey()) {
    return attachRemediationMeta(generateFallbackAnalysis(ctx), mode);
  }

  try {
    const insight = await callClaudeStructured({
      system: systemPromptForMode(mode.mode),
      userMessage: buildUserPrompt(ctx) + "\n\nKeep each string value under 200 characters.",
      schema: businessInsightSchema,
      toolName: "submit_business_analysis",
      toolDescription: "Submit the structured business analysis",
      maxTokens: 3000,
      temperature: mode.mode === "integrity" ? 0.25 : 0.4,
      purpose: "business_analysis",
    });
    return attachRemediationMeta(insight, mode);
  } catch (e) {
    logger.error({ err: e }, "Business analysis LLM call failed, using fallback");
    return attachRemediationMeta(generateFallbackAnalysis(ctx), mode);
  }
}

export interface RefineFeedback {
  overall_score: number;
  dimensions: { name: string; score: number; feedback: string }[];
  improvement_guidance: string;
}

/**
 * Regenerate analysis incorporating QA feedback and/or grounding mismatches.
 */
export async function regenerateWithFeedback(
  scenarioId: string,
  qaFeedback: RefineFeedback,
  iterationNumber: number,
  groundingMismatches?: EvidenceMismatch[],
): Promise<BusinessInsight> {
  const ctx = await loadAnalysisContext(scenarioId);
  const mode = detectAnalysisMode(ctx);

  if (!getApiKey()) {
    return attachRemediationMeta(generateFallbackAnalysis(ctx), mode);
  }

  const feedbackSection = [
    "",
    `## QA FEEDBACK — Iteration ${iterationNumber} (Score: ${qaFeedback.overall_score}/10)`,
    "The Quality Assurance Agent found the following issues with your previous analysis:",
    "",
    ...qaFeedback.dimensions.map((d) => `- **${d.name}** (${d.score}/10): ${d.feedback}`),
    "",
    "## MANDATORY IMPROVEMENT INSTRUCTIONS",
    qaFeedback.improvement_guidance,
    "",
    "You MUST address EVERY point above. Do not just rephrase — genuinely fix the issues.",
    "If the QA flagged inconsistency or absurdity, re-examine the numbers and correct your conclusions.",
    "If specificity was low, add concrete metrics, timelines, and ownership.",
  ];

  if (groundingMismatches && groundingMismatches.length > 0) {
    feedbackSection.push(
      "",
      "## GROUNDING MISMATCHES — REWRITE EVERY OCCURRENCE",
      "Cited figures must match CANONICAL METRICS (base or scenario column as appropriate). Do not invent replacements.",
      ...groundingMismatches.map((m) => formatGroundingMismatchFeedback(m)),
    );
  }

  if (mode.mode === "integrity") {
    feedbackSection.push(
      "",
      "You remain in INTEGRITY MODE. Lead with baseline failure; do not invent resilience from scenario levels alone.",
    );
  }

  try {
    const insight = await callClaudeStructured({
      system:
        systemPromptForMode(mode.mode) +
        "\n\nIMPORTANT: You are in a refinement cycle. A QA analyst reviewed your previous output and found issues. You MUST address their feedback to produce a higher-quality analysis.",
      userMessage: buildUserPrompt(ctx) + feedbackSection.join("\n") + "\n\nKeep each string value under 200 characters.",
      schema: businessInsightSchema,
      toolName: "submit_business_analysis",
      toolDescription: "Submit the structured, revised business analysis",
      maxTokens: 3000,
      temperature: groundingMismatches?.length ? 0.15 : 0.3,
      purpose: "business_analysis",
    });
    return attachRemediationMeta(insight, mode);
  } catch (e) {
    logger.error({ err: e }, `[BA Agent] Refinement iteration ${iterationNumber} failed`);
    return attachRemediationMeta(generateFallbackAnalysis(ctx), mode);
  }
}

/**
 * Grounding-only refine: pass exact mismatches without waiting on full QA prose.
 */
export async function regenerateForGrounding(
  scenarioId: string,
  mismatches: EvidenceMismatch[],
  iterationNumber: number,
): Promise<BusinessInsight> {
  return regenerateWithFeedback(
    scenarioId,
    {
      overall_score: 0,
      dimensions: [
        {
          name: "consistency",
          score: 1,
          feedback: "Numeric claims do not match computed P&L — fix grounding first",
        },
      ],
      improvement_guidance:
        "Fix grounded-evidence and free-text numeric mismatches before anything else. Use CANONICAL METRICS exactly.",
    },
    iterationNumber,
    mismatches,
  );
}

// ── Grounding verification ──

export interface EvidenceMismatch {
  implication_title: string;
  metric_id: string;
  claimed_value: number;
  actual_value: number | undefined;
}

export const EVIDENCE_TOLERANCE_PCT = 0.5;

function valuesMatch(claimed: number, actual: number): boolean {
  const tolerance = Math.max(Math.abs(actual) * (EVIDENCE_TOLERANCE_PCT / 100), 0.01);
  return Math.abs(claimed - actual) <= tolerance;
}

/** Extract numeric tokens from prose (handles 10,986.18 and 182.7). */
export function extractNumericClaims(text: string): number[] {
  // Mask years and percentages so "2025"→25 and "25–50%" never become P&L claims.
  const masked = text
    .replace(/\b(?:19|20)\d{2}\b/g, " ")
    .replace(/-?\d+(?:\.\d+)?\s*[–—-]\s*-?\d+(?:\.\d+)?\s*%/g, " ")
    .replace(/-?\d+(?:\.\d+)?\s*%/g, " ");
  const out: number[] = [];
  const re = /(?<![A-Za-z])(-?\d{1,3}(?:,\d{3})*(?:\.\d+)?|-?\d+\.\d+)(?![\w%])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked)) !== null) {
    const raw = m[1].replace(/,/g, "");
    const n = Number(raw);
    if (!Number.isFinite(n)) continue;
    // Skip small integers 0..10 (list counts, ambient "base is 0" prose).
    // Explicit base=0 citations still go through evidence[].
    if (Number.isInteger(n) && Math.abs(n) <= 10) continue;
    // Skip year-like integers if any slipped through
    if (Number.isInteger(n) && n >= 1900 && n <= 2100) continue;
    out.push(n);
  }
  return out;
}

function collectInsightProse(insight: BusinessInsight): Array<{ label: string; text: string }> {
  const parts: Array<{ label: string; text: string }> = [
    { label: "headline", text: insight.headline },
    { label: "decision_context", text: insight.decision_context },
    { label: "confidence_note", text: insight.confidence_note },
  ];
  for (const imp of insight.implications) {
    parts.push({ label: imp.title, text: `${imp.title} ${imp.detail}` });
  }
  for (const risk of insight.risks) {
    parts.push({ label: risk.risk.slice(0, 80), text: `${risk.risk} ${risk.mitigation}` });
  }
  for (const rec of insight.recommendations) {
    parts.push({ label: rec.action.slice(0, 80), text: `${rec.action} ${rec.rationale}` });
  }
  return parts;
}

/** True when prose appears to be citing this metric (not a random scale collision). */
export function metricMentionedInText(metricId: string, text: string): boolean {
  const lower = text.toLowerCase();
  const spaced = metricId.toLowerCase().replace(/_/g, " ");
  if (lower.includes(spaced)) return true;
  if (lower.includes(metricId.toLowerCase())) return true;
  // Require a distinctive multi-token overlap — a single generic token like
  // "marketing" or "cost" must not attach contingency ₹ amounts to P&L lines.
  const tokens = metricId
    .toLowerCase()
    .split("_")
    .filter((t) => t.length >= 5 && !["total", "other", "brand", "costs", "cost"].includes(t));
  if (tokens.length === 0) return false;
  const hits = tokens.filter((t) => lower.includes(t));
  return hits.length >= Math.min(2, tokens.length) || (tokens.length === 1 && hits.length === 1);
}

function findClosestMetric(
  claimed: number,
  knownValues: Record<string, number>,
): { metric_id: string; actual: number; scaleError: boolean } | null {
  let best: { metric_id: string; actual: number; scaleError: boolean; dist: number } | null = null;
  for (const [metric_id, actual] of Object.entries(knownValues)) {
    if (typeof actual !== "number" || !Number.isFinite(actual) || actual === 0) continue;
    if (valuesMatch(claimed, actual)) {
      return { metric_id, actual, scaleError: false };
    }
    const ratio = Math.abs(claimed / actual);
    const isScale =
      (ratio > 8 && ratio < 12.5) ||
      (ratio > 80 && ratio < 125) ||
      (ratio > 0.08 && ratio < 0.125) ||
      (ratio > 0.008 && ratio < 0.0125);
    if (isScale) {
      const dist = Math.abs(Math.log10(ratio) - Math.round(Math.log10(ratio)));
      if (!best || dist < best.dist) {
        best = { metric_id, actual, scaleError: true, dist };
      }
    }
  }
  // Also allow exact match on near-zero actuals
  for (const [metric_id, actual] of Object.entries(knownValues)) {
    if (typeof actual !== "number" || !Number.isFinite(actual)) continue;
    if (actual !== 0) continue;
    if (valuesMatch(claimed, actual)) {
      return { metric_id, actual, scaleError: false };
    }
  }
  return best ? { metric_id: best.metric_id, actual: best.actual, scaleError: best.scaleError } : null;
}

/**
 * Resolve evidence against scenario and/or base so integrity-mode
 * "base=0" citations are valid even when scenario levels are material.
 *
 * Missing base keys are treated as 0 — same as P&L delta math (`base_pl[k] ?? 0`).
 */
function resolveEvidenceActual(
  metricId: string,
  claimed: number,
  scenarioValues: Record<string, number>,
  baseValues?: Record<string, number>,
): { actual: number; matched: boolean } | null {
  const scenario = scenarioValues[metricId];
  const hasScenario = typeof scenario === "number" && Number.isFinite(scenario);
  const baseRaw = baseValues?.[metricId];
  const hasExplicitBase = typeof baseRaw === "number" && Number.isFinite(baseRaw);

  if (!hasScenario && !hasExplicitBase) return null;

  // Align with simulation/QA display: absent base line ⇒ 0
  const base = hasExplicitBase ? baseRaw : 0;

  if (hasScenario && valuesMatch(claimed, scenario)) {
    return { actual: scenario, matched: true };
  }
  if (valuesMatch(claimed, base)) {
    return { actual: base, matched: true };
  }
  // Prefer reporting the column the claim was closest to intending
  if (Math.abs(claimed) <= BASE_NEAR_ZERO) {
    return { actual: base, matched: false };
  }
  if (hasScenario) return { actual: scenario, matched: false };
  return { actual: base, matched: false };
}

/** Merge scenario + base for free-text lookup without wiping base zeros. */
function mergeKnownForLookup(
  scenarioValues: Record<string, number>,
  baseValues?: Record<string, number>,
): Record<string, number> {
  const out: Record<string, number> = { ...(baseValues ?? {}) };
  for (const [k, v] of Object.entries(scenarioValues)) {
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    out[k] = v;
    // Implicit base=0 when key absent from base_pl (same as delta math)
    const baseRaw = baseValues?.[k];
    const base = typeof baseRaw === "number" && Number.isFinite(baseRaw) ? baseRaw : 0;
    if (Math.abs(base) <= BASE_NEAR_ZERO && Math.abs(v) > BASE_NEAR_ZERO) {
      out[`__base__${k}`] = base;
    }
  }
  if (baseValues) {
    for (const [k, v] of Object.entries(baseValues)) {
      if (typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= BASE_NEAR_ZERO) {
        if (Math.abs(out[k] ?? 1) > BASE_NEAR_ZERO) {
          out[`__base__${k}`] = v;
        }
      }
    }
  }
  return out;
}

function formatGroundingMismatchFeedback(m: EvidenceMismatch): string {
  const claimedZero =
    Math.abs(m.claimed_value) <= BASE_NEAR_ZERO &&
    m.actual_value != null &&
    Math.abs(m.actual_value) > BASE_NEAR_ZERO;
  if (claimedZero) {
    return `- "${m.implication_title}": ${m.metric_id} claimed ${m.claimed_value} but base/scenario value is ${m.actual_value}. Only cite 0 when the CANONICAL base column is ~0; for scenario levels copy the scenario column into evidence.value.`;
  }
  if (m.actual_value == null) {
    return `- "${m.implication_title}": ${m.metric_id} claimed ${m.claimed_value} → N/A (remove claim or pick a real metric_id from CANONICAL METRICS)`;
  }
  return `- "${m.implication_title}": ${m.metric_id} claimed ${m.claimed_value} → use ${m.actual_value}`;
}

/**
 * Sync grounding check against known scenario (and optional base) values.
 * Unit-testable; no DB.
 */
export function verifyEvidenceAgainstValues(
  insight: BusinessInsight,
  knownValues: Record<string, number>,
  baseValues?: Record<string, number>,
): { ok: boolean; mismatches: EvidenceMismatch[] } {
  const mismatches: EvidenceMismatch[] = [];
  const lookup = mergeKnownForLookup(knownValues, baseValues);

  const pushUnique = (m: EvidenceMismatch) => {
    const exists = mismatches.some(
      (x) =>
        x.implication_title === m.implication_title &&
        x.metric_id === m.metric_id &&
        x.claimed_value === m.claimed_value &&
        x.actual_value === m.actual_value,
    );
    if (!exists) mismatches.push(m);
  };

  for (const imp of insight.implications) {
    const evidence = imp.evidence ?? [];
    for (const ev of evidence) {
      const resolved = resolveEvidenceActual(ev.metric_id, ev.value, knownValues, baseValues);
      if (!resolved) {
        pushUnique({
          implication_title: imp.title,
          metric_id: ev.metric_id,
          claimed_value: ev.value,
          actual_value: undefined,
        });
        continue;
      }
      if (!resolved.matched) {
        pushUnique({
          implication_title: imp.title,
          metric_id: ev.metric_id,
          claimed_value: ev.value,
          actual_value: resolved.actual,
        });
      }
    }

    const prose = `${imp.title} ${imp.detail}`;
    const claims = extractNumericClaims(prose);
    const modelBacked = claims.filter((c) => {
      const hit = findClosestMetric(c, lookup);
      return hit && !hit.scaleError && valuesMatch(c, hit.actual);
    });
    if (modelBacked.length > 0 && evidence.length === 0) {
      pushUnique({
        implication_title: imp.title,
        metric_id: "evidence_required",
        claimed_value: modelBacked[0],
        actual_value: findClosestMetric(modelBacked[0], lookup)?.actual,
      });
    }
    for (const claimed of claims) {
      const hit = findClosestMetric(claimed, lookup);
      if (!hit) continue; // qualitative / lever / contingency number — not a model citation
      if (!hit.scaleError && valuesMatch(claimed, hit.actual)) continue;
      // Scale / near-miss: only fail when the metric is actually being discussed
      const metricId = hit.metric_id.startsWith("__base__")
        ? hit.metric_id.slice("__base__".length)
        : hit.metric_id;
      if (hit.scaleError && !metricMentionedInText(metricId, prose)) continue;
      pushUnique({
        implication_title: imp.title,
        metric_id: metricId,
        claimed_value: claimed,
        actual_value: hit.actual,
      });
    }
  }

  // Elsewhere: only flag mis-scaled citations of metrics named in the prose
  // (do not fail qualitative reserves like "₹50 Cr contingency" or timeline years).
  for (const part of collectInsightProse(insight)) {
    const isImplication = insight.implications.some(
      (i) => part.label === i.title || part.text.startsWith(i.title),
    );
    if (isImplication) continue;
    for (const claimed of extractNumericClaims(part.text)) {
      const hit = findClosestMetric(claimed, lookup);
      if (!hit) continue;
      if (!hit.scaleError && valuesMatch(claimed, hit.actual)) continue;
      const metricId = hit.metric_id.startsWith("__base__")
        ? hit.metric_id.slice("__base__".length)
        : hit.metric_id;
      if (!metricMentionedInText(metricId, part.text)) continue;
      pushUnique({
        implication_title: part.label,
        metric_id: metricId,
        claimed_value: claimed,
        actual_value: hit.actual,
      });
    }
  }

  return { ok: mismatches.length === 0, mismatches };
}

/**
 * Check that every evidence-backed claim and free-text numeric citation
 * matches a computed metric (scenario or base P&L) within tolerance.
 */
export async function verifyEvidence(
  insight: BusinessInsight,
  scenarioId: string,
): Promise<{ ok: boolean; mismatches: EvidenceMismatch[] }> {
  const ctx = await loadAnalysisContext(scenarioId);
  return verifyEvidenceAgainstValues(insight, ctx.pl, ctx.base_pl);
}

/** Load mode for a scenario (used by QA context builder). */
export async function getAnalysisModeForScenario(scenarioId: string): Promise<AnalysisModeResult> {
  const ctx = await loadAnalysisContext(scenarioId);
  return detectAnalysisMode(ctx);
}
