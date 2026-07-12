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

import { z } from "zod";
import { getApiKey, callClaudeStructured } from "./llmClient.js";
import { pool } from "../db/index.js";
import type { BusinessInsight } from "./businessAnalysisAgent.js";
import { verifyEvidence } from "./businessAnalysisAgent.js";
import { logger } from "../logger.js";

const qaResponseSchema = z.object({
  overall_score: z.number().min(0).max(10),
  dimensions: z.array(z.object({
    name: z.string(),
    score: z.number().min(0).max(10),
    feedback: z.string(),
  })),
  improvement_guidance: z.string(),
  summary: z.string(),
});

export interface QADimension {
  name: string;
  score: number;
  feedback: string;
}

export interface QAReport {
  /**
   * "assessed": the QA agent actually evaluated the analysis.
   * "not_assessed": QA could not run (no API key / LLM failure) — the
   * analysis is unvalidated and must NOT be presented as having passed QA.
   */
  status: "assessed" | "not_assessed";
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

Keep feedback strings SHORT (under 100 chars each). Submit scores and guidance via the structured tool.`

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
  const { getModelDefinition } = await import("../models/registry.js");
  const { resolveBasePl } = await import("./basePl.js");
  const model = await getModelDefinition(modelHash);
  const base_pl = await resolveBasePl(rawPl, model);

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
 * `scenarioId` is used for the numeric-consistency check: every metric the
 * analysis cites as evidence must match a computed P&L value — an LLM
 * asserting a number that isn't in the underlying data is a grounding
 * failure, scored and reported distinctly from writing-quality issues.
 */
export async function evaluateAnalysis(
  analysis: BusinessInsight,
  scenarioContext: string,
  scenarioId: string,
): Promise<QAReport> {
  const grounding = await verifyEvidence(analysis, scenarioId).catch(() => ({ ok: true, mismatches: [] }));

  if (!getApiKey()) {
    // Previously this returned passed:true with a fabricated 7/10 — an
    // unvalidated analysis must never be reported as having passed QA.
    return {
      status: "not_assessed",
      overall_score: 0,
      passed: false,
      dimensions: [],
      improvement_guidance: "",
      summary: "QA was not run — the LLM is unavailable (API key not configured). This analysis has not been quality-checked.",
      iterations: 0,
    };
  }

  const groundingNote = grounding.ok
    ? ""
    : `\n\n## GROUNDING CHECK FAILED\nThe following cited figures do not match the computed P&L data:\n${grounding.mismatches
        .map((m) => `- "${m.implication_title}" cites ${m.metric_id}=${m.claimed_value}, but the computed value is ${m.actual_value ?? "not present in the model"}`)
        .join("\n")}\nScore "consistency" no higher than 2/10 and require the analysis to correct these figures.`;

  const userMessage = `## Scenario Context\n${scenarioContext}\n\n## Analysis Being Reviewed\n${JSON.stringify(analysis, null, 2)}${groundingNote}\n\nEvaluate this analysis rigorously. Score each dimension 1-10 and provide specific improvement guidance.`;

  try {
    const parsed = await callClaudeStructured({
      system: QA_SYSTEM_PROMPT,
      userMessage,
      schema: qaResponseSchema,
      toolName: "submit_qa_evaluation",
      toolDescription: "Submit the QA evaluation scores and feedback",
      maxTokens: 2500,
      temperature: 0.3,
      purpose: "qa",
    });

    const overallScore = grounding.ok ? parsed.overall_score : Math.min(parsed.overall_score, QA_THRESHOLD - 1);

    return {
      status: "assessed",
      overall_score: overallScore,
      passed: grounding.ok && overallScore >= QA_THRESHOLD,
      dimensions: parsed.dimensions,
      improvement_guidance: grounding.ok
        ? parsed.improvement_guidance
        : `Fix these grounded-evidence mismatches before anything else:\n${grounding.mismatches.map((m) => `- ${m.implication_title}: ${m.metric_id} claimed ${m.claimed_value}, actual ${m.actual_value ?? "N/A"}`).join("\n")}\n\n${parsed.improvement_guidance}`,
      summary: parsed.summary,
      iterations: 1,
    };
  } catch (e) {
    const errMsg = (e as Error).message;
    logger.error({ err: e }, "[QA Agent] Evaluation failed");
    return {
      status: "not_assessed",
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
