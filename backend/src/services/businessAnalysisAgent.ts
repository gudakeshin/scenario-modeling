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

import { getApiKey, callClaude } from "./llmClient.js";
import { pool } from "../db/index.js";
import { computeBaseCase } from "../models/registry.js";

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

// ── Types ──

export interface BusinessInsight {
  headline: string;
  implications: { title: string; detail: string; severity: "positive" | "negative" | "neutral" }[];
  risks: { risk: string; likelihood: "high" | "medium" | "low"; mitigation: string }[];
  recommendations: { action: string; priority: "immediate" | "short-term" | "monitor"; rationale: string; owner?: string }[];
  decision_context: string;
  confidence_note: string;
}

interface AnalysisContext {
  scenario_name: string | null;
  nl_input: string;
  pl: Record<string, number>;
  base_pl: Record<string, number>;
  parameters: { name: string; variable_id: string; value: number; status: string }[];
  sensitivity?: { target_metric: string; bars: { variable_name: string; spread: number; low_delta: number; high_delta: number }[] } | null;
  monte_carlo?: { metrics: Record<string, { p10: number; p50: number; p90: number; mean: number; stddev: number }> } | null;
  currency_symbol: string;
  absurdity_warnings?: string[];
  period_count?: number;
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

// ── Data loader ──

async function loadAnalysisContext(scenarioId: string): Promise<AnalysisContext> {
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
  const model = await getModel(modelHash);
  const baseCtx = model ? await computeBaseCase(model) : {};
  const base_pl: Record<string, number> = {};
  for (const [k, v] of Object.entries(baseCtx)) {
    base_pl[k] = Math.round(v * 100) / 100;
  }

  const currency_symbol = await getCurrencyFromContext(scenarioId);

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
  };
}

// ── Heuristic fallback (no LLM) ──

function generateFallbackAnalysis(ctx: AnalysisContext): BusinessInsight {
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
    ? `This analysis incorporates ${dataRichness.join(" and ")} data, providing higher confidence in the conclusions. AI-generated — review with domain experts before acting.`
    : `This analysis is based on deterministic scenario results only. Running sensitivity and Monte Carlo analyses would strengthen confidence. AI-generated — review required.`;

  return { headline, implications, risks, recommendations, decision_context, confidence_note };
}

// ── LLM-powered analysis ──

const SYSTEM_PROMPT = `You are a senior business strategy analyst. Given financial scenario data, you produce structured "So What?" analysis.

You must return ONLY valid JSON matching this exact schema:
{
  "headline": "One sentence: the single most important business takeaway",
  "implications": [
    {"title": "Short title", "detail": "2-3 sentence explanation", "severity": "positive|negative|neutral"}
  ],
  "risks": [
    {"risk": "Description", "likelihood": "high|medium|low", "mitigation": "Concrete action"}
  ],
  "recommendations": [
    {"action": "Specific action item", "priority": "immediate|short-term|monitor", "rationale": "Why this matters", "owner": "Team/Role"}
  ],
  "decision_context": "2-3 sentences framing the decision for executives",
  "confidence_note": "How reliable is this analysis + what would strengthen it"
}

Rules:
- implications: 3-5 items, focus on BUSINESS impact not just numbers
- risks: 2-4 items, each with a specific mitigation action
- recommendations: 3-5 items, ordered by priority. Each must be CONCRETE and ACTIONABLE (not "consider" or "think about" — use "do X", "establish Y", "convene Z")
- Always ask "so what does this mean for the business?" — don't just restate the numbers
- Recommendations should name an owner (FP&A, Operations, Sales, Strategy, CEO, etc.)
- The headline should be something a CEO can read in 5 seconds and know the key decision
- End confidence_note with: "AI-generated analysis — validate with domain experts."`;

function buildUserPrompt(ctx: AnalysisContext): string {
  const c = ctx.currency_symbol;
  const parts = [
    `## Scenario: "${ctx.nl_input}"`,
    `Name: ${ctx.scenario_name || "(unnamed)"}`,
    ctx.period_count ? `Periods: ${ctx.period_count} quarters` : "",
    "",
    "## Assumptions Changed",
    ...ctx.parameters.map((p) => `- ${p.name} (${p.variable_id}): ${p.value}% [${p.status}]`),
    "",
    "## P&L Impact Per Period (Base → Scenario, single quarter)",
  ];
  for (const [metric, val] of Object.entries(ctx.pl)) {
    const base = ctx.base_pl[metric] ?? 0;
    const delta = val - base;
    const pct = base !== 0 ? ((delta / base) * 100).toFixed(1) : "n/a";
    parts.push(`- ${metric}: ${c}${base.toLocaleString()} → ${c}${val.toLocaleString()} (${delta >= 0 ? "+" : "-"}${c}${Math.abs(delta).toLocaleString()}, ${pct}%)`);
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
    parts.push("", "NOTE: The simulation flagged potentially unrealistic results. Your analysis MUST acknowledge these warnings, explain possible causes (e.g. compounding effects, formula issues), and caveat any conclusions built on these numbers.");
  }

  parts.push("", "Produce your structured business analysis focusing on 'So what does this mean?' and 'What should we do next?'");
  return parts.join("\n");
}

export async function generateBusinessAnalysis(scenarioId: string): Promise<BusinessInsight> {
  const ctx = await loadAnalysisContext(scenarioId);

  if (!getApiKey()) {
    return generateFallbackAnalysis(ctx);
  }

  try {
    const rawText = await callClaude({
      system: SYSTEM_PROMPT,
      userMessage: buildUserPrompt(ctx) + "\n\nReturn JSON only — no markdown, no code fences. Keep each string value under 200 characters.",
      maxTokens: 3000,
      temperature: 0.4,
    });

    const repaired = repairJson(rawText);
    if (!repaired) return generateFallbackAnalysis(ctx);

    const parsed = JSON.parse(repaired) as BusinessInsight;

    if (!parsed.headline || !Array.isArray(parsed.implications) || !Array.isArray(parsed.recommendations)) {
      return generateFallbackAnalysis(ctx);
    }

    return parsed;
  } catch (e) {
    console.error("Business analysis LLM call failed, using fallback:", (e as Error).message);
    return generateFallbackAnalysis(ctx);
  }
}

/**
 * Regenerate analysis incorporating QA feedback.
 * This is the key method for the QA-BA reflection loop: the Business Analysis Agent
 * receives specific QA criticism and produces a genuinely improved analysis.
 */
export async function regenerateWithFeedback(
  scenarioId: string,
  qaFeedback: { overall_score: number; dimensions: { name: string; score: number; feedback: string }[]; improvement_guidance: string },
  iterationNumber: number,
): Promise<BusinessInsight> {
  const ctx = await loadAnalysisContext(scenarioId);

  if (!getApiKey()) {
    return generateFallbackAnalysis(ctx);
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
  ].join("\n");

  try {
    const rawText = await callClaude({
      system: SYSTEM_PROMPT + "\n\nIMPORTANT: You are in a refinement cycle. A QA analyst reviewed your previous output and found issues. You MUST address their feedback to produce a higher-quality analysis.",
      userMessage: buildUserPrompt(ctx) + feedbackSection + "\n\nReturn JSON only — no markdown, no code fences. Keep each string value under 200 characters.",
      maxTokens: 3000,
      temperature: 0.3,
    });

    const repaired = repairJson(rawText);
    if (!repaired) return generateFallbackAnalysis(ctx);

    const parsed = JSON.parse(repaired) as BusinessInsight;

    if (!parsed.headline || !Array.isArray(parsed.implications) || !Array.isArray(parsed.recommendations)) {
      return generateFallbackAnalysis(ctx);
    }

    return parsed;
  } catch (e) {
    console.error(`[BA Agent] Refinement iteration ${iterationNumber} failed:`, (e as Error).message);
    return generateFallbackAnalysis(ctx);
  }
}
