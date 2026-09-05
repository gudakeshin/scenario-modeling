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
import type { BusinessInsight, AnalysisModeResult, EvidenceMismatch } from "./businessAnalysisAgent.js";
import {
  verifyEvidence,
  detectAnalysisMode,
  analysisMentionsIntegrity,
  getAnalysisModeForScenario,
} from "./businessAnalysisAgent.js";
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
  /** Present when numeric grounding failed (for orchestration refine path). */
  grounding_mismatches?: EvidenceMismatch[];
  analysis_mode?: "standard" | "integrity";
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

const QA_SYSTEM_PROMPT_STANDARD = `You are a QA analyst reviewing business scenario analysis. Score each dimension 1-10.

ABSURDITY CHECK (CRITICAL — do this FIRST) — STANDARD MODE:
- If any P&L change exceeds ±200% and the analysis treats it as a real business outcome without justification, flag it and score consistency ≤2/10.
- If EBITDA, revenue, or net income changes are wildly disproportionate to the stated scenario (e.g. a 10% cost increase causing >50% EBITDA change) and the write-up treats that as real impact, flag as inconsistent.
- If the analysis describes huge impacts but the scenario is minor, call it out.

Dimensions: completeness, specificity, actionability, consistency, business_relevance, risk_coverage.

Keep feedback strings SHORT (under 100 chars each). Submit scores and guidance via the structured tool.
If you cite a figure in your feedback, keep the unit the scenario context gave it (e.g. Crore) — never convert it to Million/Billion/Lakh.`;

const QA_SYSTEM_PROMPT_INTEGRITY = `You are a QA analyst reviewing business scenario analysis in INTEGRITY MODE (zero/missing baseline or uninterpretable % deltas).

Score each dimension 1-10. CONSISTENCY RULES FOR INTEGRITY MODE (do these FIRST):
- Score consistency HIGH (7–10) when the analysis (1) leads with baseline/setup/model-integrity failure, (2) treats ±200% / n/a% swings as math artifacts not business outcomes, (3) cites only canonical scenario levels with correct figures, (4) does NOT claim proven net impact or unverifiable "resilience".
- Do NOT auto-penalize consistency merely because underlying P&L % swings look absurd — that is expected when baseline is broken. Penalize only if the write-up treats those swings as real business results.
- Fail consistency (≤2) if the analysis claims healthy margins/revenue intact as proven vs base, or if it omits the model-integrity diagnosis.
- Actionability should reward: fix baseline + re-run first, then qualitative preparedness tied to assumption levers.

Dimensions: completeness, specificity, actionability, consistency, business_relevance, risk_coverage.

Keep feedback strings SHORT (under 100 chars each). Submit scores and guidance via the structured tool.
If you cite a figure in your feedback, keep the unit the scenario context gave it (e.g. Crore) — never convert it to Million/Billion/Lakh.`;

function qaSystemPrompt(mode: AnalysisModeResult["mode"]): string {
  return mode === "integrity" ? QA_SYSTEM_PROMPT_INTEGRITY : QA_SYSTEM_PROMPT_STANDARD;
}

/**
 * Deterministic integrity gate: analyses in integrity mode must diagnose the setup failure.
 */
export function integrityDiagnosisCheck(
  analysis: BusinessInsight,
  mode: AnalysisModeResult,
): { ok: boolean; guidance: string } {
  if (mode.mode !== "integrity") return { ok: true, guidance: "" };
  if (analysisMentionsIntegrity(analysis)) return { ok: true, guidance: "" };
  return {
    ok: false,
    guidance:
      "Lead with model-integrity / zero-baseline diagnosis in the headline and implications. Do not treat scenario levels as proven net impact until a valid base P&L is loaded.",
  };
}

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
  // Every figure below is already in the workbook's own scale (e.g. Crore).
  // Without stating that, an LLM handed a bare number like "28,488.46"
  // invents its own unit when it writes up findings — this is what produced
  // a QA finding that read "revenue (₹26,000M)" for a ₹26,000 Crore figure.
  const unitRes = await pool.query(
    `SELECT cc.context_data->>'currency' AS currency, cc.context_data->>'currency_unit' AS currency_unit
     FROM company_context cc
     JOIN user_models um ON um.source_context_id = cc.context_id
     JOIN scenarios s ON s.model_version_hash = um.model_id::text
     WHERE s.scenario_id = $1 LIMIT 1`,
    [scenarioId],
  );
  const currencyUnit = unitRes.rows[0]?.currency_unit as string | undefined;

  const rawPl = plRes.rows[0]?.output_data ?? {};
  const periods = rawPl.periods ?? [];
  const pl: Record<string, number> = periods.length > 0
    ? periods[0].pl
    : (rawPl.aggregate ?? rawPl);
  const absurdity_warnings: string[] = rawPl.absurdity_warnings ?? [];

  const modelRef = await pool.query("SELECT model_version_hash FROM scenarios WHERE scenario_id = $1", [scenarioId]);
  const modelHash = modelRef.rows[0]?.model_version_hash;
  const { getModelDefinition } = await import("../models/registry.js");
  const { resolveBasePl } = await import("./basePl.js");
  const model = await getModelDefinition(modelHash);
  const base_pl = await resolveBasePl(rawPl, model, scenarioId);
  const mode = detectAnalysisMode({ pl, base_pl, absurdity_warnings });

  const u = currencyUnit ? ` ${currencyUnit}` : "";
  const lines = [
    `Scenario: "${sRes.rows[0]?.nl_input || ""}"`,
    `ANALYSIS_MODE: ${mode.mode}`,
    ...(mode.reasons.length > 0 ? mode.reasons.map((r) => `MODE_REASON: ${r}`) : []),
    ...(currencyUnit
      ? [`All figures below are already in ${currencyUnit} — cite them with that exact unit, never as Million/Billion/Lakh or any other scale.`]
      : []),
    "",
    "Parameters:",
    ...pRes.rows.map((r: { extracted_name: string; scenario_value: number }) =>
      `  - ${r.extracted_name}: ${Number(r.scenario_value)}`),
    "",
    "P&L Changes (Base → Scenario, per period):",
  ];
  for (const [k, v] of Object.entries(pl)) {
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    const base = base_pl[k] ?? 0;
    const delta = v - base;
    if (Math.abs(delta) > 0.01 || Math.abs(v) > 0.01) {
      const pct = Math.abs(base) > 0.01 ? ((delta / base) * 100).toFixed(1) : "n/a";
      lines.push(`  - ${k}: ${base.toLocaleString()}${u} → ${v.toLocaleString()}${u} (${delta >= 0 ? "+" : ""}${delta.toLocaleString()}${u}, ${pct}%)`);
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
  let grounding: { ok: boolean; mismatches: EvidenceMismatch[] };
  try {
    grounding = await verifyEvidence(analysis, scenarioId);
  } catch (e) {
    logger.error({ err: e }, "[QA Agent] Grounding verification failed");
    grounding = {
      ok: false,
      mismatches: [{
        implication_title: "grounding_error",
        metric_id: "verify_evidence",
        claimed_value: 0,
        actual_value: undefined,
      }],
    };
  }

  let mode: AnalysisModeResult;
  try {
    mode = await getAnalysisModeForScenario(scenarioId);
  } catch (e) {
    logger.warn({ err: e }, "[QA Agent] Could not load analysis mode; defaulting to standard");
    mode = { mode: "standard", reasons: [] };
  }

  const integrityCheck = integrityDiagnosisCheck(analysis, mode);

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
      grounding_mismatches: grounding.ok ? undefined : grounding.mismatches,
      analysis_mode: mode.mode,
    };
  }

  const groundingNote = grounding.ok
    ? ""
    : `\n\n## GROUNDING CHECK FAILED\nThe following cited figures do not match the computed P&L data:\n${grounding.mismatches
        .map((m) => `- "${m.implication_title}" cites ${m.metric_id}=${m.claimed_value}, but the computed value is ${m.actual_value ?? "not present in the model"}`)
        .join("\n")}\nScore "consistency" no higher than 2/10 and require the analysis to correct these figures.`;

  const integrityNote = integrityCheck.ok
    ? ""
    : `\n\n## INTEGRITY DIAGNOSIS CHECK FAILED\n${integrityCheck.guidance}\nScore consistency no higher than 2/10 until the analysis leads with model-integrity diagnosis.`;

  const userMessage = `## Scenario Context\n${scenarioContext}\n\n## Analysis Being Reviewed\n${JSON.stringify(analysis, null, 2)}${groundingNote}${integrityNote}\n\nEvaluate this analysis rigorously. Score each dimension 1-10 and provide specific improvement guidance.`;

  try {
    const parsed = await callClaudeStructured({
      system: qaSystemPrompt(mode.mode),
      userMessage,
      schema: qaResponseSchema,
      toolName: "submit_qa_evaluation",
      toolDescription: "Submit the QA evaluation scores and feedback",
      maxTokens: 2500,
      temperature: 0.3,
      purpose: "qa",
    });

    const structuralOk = grounding.ok && integrityCheck.ok;
    let overallScore = parsed.overall_score;
    if (!structuralOk) {
      overallScore = Math.min(overallScore, QA_THRESHOLD - 1);
    }

    const guidanceParts: string[] = [];
    if (!grounding.ok) {
      guidanceParts.push(
        `Fix these grounded-evidence mismatches before anything else:\n${grounding.mismatches.map((m) => `- ${m.implication_title}: ${m.metric_id} claimed ${m.claimed_value}, actual ${m.actual_value ?? "N/A"}`).join("\n")}`,
      );
    }
    if (!integrityCheck.ok) {
      guidanceParts.push(integrityCheck.guidance);
    }
    guidanceParts.push(parsed.improvement_guidance);

    return {
      status: "assessed",
      overall_score: overallScore,
      passed: structuralOk && overallScore >= QA_THRESHOLD,
      dimensions: parsed.dimensions,
      improvement_guidance: guidanceParts.join("\n\n"),
      summary: parsed.summary,
      iterations: 1,
      grounding_mismatches: grounding.ok ? undefined : grounding.mismatches,
      analysis_mode: mode.mode,
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
      grounding_mismatches: grounding.ok ? undefined : grounding.mismatches,
      analysis_mode: mode.mode,
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
