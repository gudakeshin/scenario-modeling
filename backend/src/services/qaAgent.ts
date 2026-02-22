/**
 * Quality Assurance Agent — Evaluation Only
 *
 * Evaluates business analysis quality across multiple dimensions.
 * Does NOT refine — refinement is done by the Business Analysis Agent
 * when called with QA feedback (see regenerateWithFeedback).
 *
 * The orchestration loop lives in the scenarios route:
 *   BA generates → QA evaluates → if fails → BA regenerates with feedback → QA re-evaluates → ...
 */

import { getApiKey, callClaude } from "./llmClient.js";
import { pool } from "../db/index.js";
import type { BusinessInsight } from "./businessAnalysisAgent.js";

function repairJson(raw: string): string {
  let text = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try { JSON.parse(text); return text; } catch { /* needs repair */ }
  text = text.replace(/,\s*"[^"]*":\s*"[^"]*$/, "");
  text = text.replace(/,\s*"[^"]*":\s*$/, "");
  text = text.replace(/,\s*$/, "");
  const openBraces = (text.match(/{/g) || []).length;
  const closeBraces = (text.match(/}/g) || []).length;
  const openBrackets = (text.match(/\[/g) || []).length;
  const closeBrackets = (text.match(/]/g) || []).length;
  for (let i = 0; i < openBrackets - closeBrackets; i++) {
    text = text.replace(/,\s*$/, "") + "]";
  }
  for (let i = 0; i < openBraces - closeBraces; i++) {
    text = text.replace(/,\s*$/, "") + "}";
  }
  try { JSON.parse(text); return text; } catch { /* still broken */ }
  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try { JSON.parse(match[0]); return match[0]; } catch { /* give up */ }
  }
  return text;
}

export interface QADimension {
  name: string;
  score: number;
  feedback: string;
}

export interface QAReport {
  overall_score: number;
  passed: boolean;
  dimensions: QADimension[];
  improvement_guidance: string;
  summary: string;
  iterations: number;
}

/** One step in the QA-BA reflection loop, visible to the user */
export interface ReflectionStep {
  agent: "Business Analysis" | "Quality Assurance";
  action: string;
  detail: string;
  score?: number;
  passed?: boolean;
  duration_ms: number;
}

export interface QAResult {
  analysis: BusinessInsight;
  qa_report: QAReport;
  reflection_log: ReflectionStep[];
}

export const QA_THRESHOLD = 6;
export const MAX_QA_ITERATIONS = 3;

const QA_SYSTEM_PROMPT = `You are a QA analyst reviewing business scenario analysis. Score each dimension 1-10.

ABSURDITY CHECK (CRITICAL — do this FIRST):
- If any P&L change exceeds ±200% and there's no clear justification, flag it as absurd and score consistency 1/10.
- If EBITDA, revenue, or net income changes are wildly disproportionate to the stated scenario (e.g. a 10% cost increase causing >50% EBITDA change), flag as inconsistent.
- If the analysis describes huge impacts but the scenario is minor, call it out.

Dimensions: completeness, specificity, actionability, consistency, business_relevance, risk_coverage.

Return ONLY valid JSON (no markdown). Keep feedback strings SHORT (under 100 chars each):
{"overall_score":N,"dimensions":[{"name":"completeness","score":N,"feedback":"..."},{"name":"specificity","score":N,"feedback":"..."},{"name":"actionability","score":N,"feedback":"..."},{"name":"consistency","score":N,"feedback":"..."},{"name":"business_relevance","score":N,"feedback":"..."},{"name":"risk_coverage","score":N,"feedback":"..."}],"improvement_guidance":"numbered instructions","summary":"2 sentence assessment"}`;

/**
 * Build scenario context string for QA evaluation.
 */
export async function buildScenarioContext(scenarioId: string): Promise<string> {
  const sRes = await pool.query("SELECT nl_input FROM scenarios WHERE scenario_id = $1", [scenarioId]);
  const plRes = await pool.query(
    "SELECT output_data FROM scenario_outputs WHERE scenario_id = $1 AND output_type = 'pl' ORDER BY created_at DESC LIMIT 1",
    [scenarioId]
  );
  const pRes = await pool.query(
    "SELECT extracted_name, scenario_value FROM scenario_parameters WHERE scenario_id = $1 AND status != 'rejected'",
    [scenarioId]
  );

  const rawPl = plRes.rows[0]?.output_data ?? {};
  const periods = rawPl.periods ?? [];
  const pl: Record<string, number> = periods.length > 0
    ? periods[0].pl
    : (rawPl.aggregate ?? rawPl);

  const modelRef = await pool.query("SELECT model_version_hash FROM scenarios WHERE scenario_id = $1", [scenarioId]);
  const modelHash = modelRef.rows[0]?.model_version_hash;
  const { computeBaseCase, getModelDefinition } = await import("../models/registry.js");
  const model = await getModelDefinition(modelHash);
  const baseCtx = model ? await computeBaseCase(model) : {};
  const base_pl: Record<string, number> = {};
  for (const [k, v] of Object.entries(baseCtx)) base_pl[k] = Math.round(v * 100) / 100;

  const lines = [
    `Scenario: "${sRes.rows[0]?.nl_input || ""}"`,
    "",
    "Parameters:",
    ...pRes.rows.map((r: { extracted_name: string; scenario_value: number }) =>
      `  - ${r.extracted_name}: ${Number(r.scenario_value)}`),
    "",
    "P&L Changes (Base → Scenario, per period):",
  ];
  for (const [k, v] of Object.entries(pl)) {
    const base = base_pl[k] ?? 0;
    const delta = v - base;
    if (Math.abs(delta) > 0.01) {
      const pct = base !== 0 ? ((delta / base) * 100).toFixed(1) : "n/a";
      lines.push(`  - ${k}: ${base.toLocaleString()} → ${v.toLocaleString()} (${delta >= 0 ? "+" : ""}${delta.toLocaleString()}, ${pct}%)`);
    }
  }
  return lines.join("\n");
}

/**
 * Evaluate a business analysis. Returns a QA report with scores and feedback.
 */
export async function evaluateAnalysis(
  analysis: BusinessInsight,
  scenarioContext: string,
): Promise<QAReport> {
  if (!getApiKey()) {
    return {
      overall_score: 7,
      passed: true,
      dimensions: [{ name: "completeness", score: 7, feedback: "Unable to assess — LLM unavailable" }],
      improvement_guidance: "",
      summary: "QA assessment unavailable — API key not configured.",
      iterations: 0,
    };
  }

  const userMessage = `## Scenario Context\n${scenarioContext}\n\n## Analysis Being Reviewed\n${JSON.stringify(analysis, null, 2)}\n\nEvaluate this analysis rigorously. Score each dimension 1-10 and provide specific improvement guidance.`;

  try {
    const rawText = await callClaude({
      system: QA_SYSTEM_PROMPT,
      userMessage,
      maxTokens: 2500,
      temperature: 0.3,
    });

    const text = repairJson(rawText);
    const parsed = JSON.parse(text) as {
      overall_score: number;
      dimensions: QADimension[];
      improvement_guidance: string;
      summary: string;
    };

    return {
      overall_score: parsed.overall_score,
      passed: parsed.overall_score >= QA_THRESHOLD,
      dimensions: parsed.dimensions || [],
      improvement_guidance: parsed.improvement_guidance || "",
      summary: parsed.summary || "",
      iterations: 1,
    };
  } catch (e) {
    const errMsg = (e as Error).message;
    console.error("[QA Agent] Evaluation failed:", errMsg);
    return {
      overall_score: 0,
      passed: false,
      dimensions: [{ name: "qa_error", score: 0, feedback: `QA evaluation failed: ${errMsg}` }],
      improvement_guidance: "",
      summary: `Quality assessment could not be completed: ${errMsg}. The analysis is shown as-is without QA validation.`,
      iterations: 0,
    };
  }
}

/**
 * Store the QA report in the database.
 */
export async function storeQAReport(scenarioId: string, report: QAReport): Promise<void> {
  await pool.query(
    `INSERT INTO scenario_outputs (scenario_id, output_type, output_data) VALUES ($1, 'qa_report', $2)`,
    [scenarioId, JSON.stringify(report)]
  );
}
