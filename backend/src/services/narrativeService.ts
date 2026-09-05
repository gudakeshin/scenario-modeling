import { z } from "zod";
import { getApiKey, callClaudeStructured } from "./llmClient.js";
import { pool } from "../db/index.js";

export interface NarrativeInput {
  scenario_name: string | null;
  nl_input: string;
  pl: Record<string, number>;
  parameters: { name: string; direction: string; magnitude: number; unit: string }[];
  audience?: "board" | "internal";
  /** Display symbol (₹, $, €, …) — never hardcode USD. */
  currency_symbol?: string;
  /** e.g. "Crore" — every figure in `pl` is already expressed in this scale. */
  currency_unit?: string;
}

const narrativeSchema = z.object({
  narrative: z.string().min(1),
});

const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: "$", EUR: "€", GBP: "£", INR: "₹", JPY: "¥", CNY: "¥",
  AUD: "A$", CAD: "C$", CHF: "CHF", SGD: "S$",
};

/**
 * Prefer first-period P&L when multi-period output exists (same basis as BA/QA).
 * Falls back to aggregate, then the raw object.
 */
export function extractSinglePeriodPl(rawPl: unknown): Record<string, number> {
  if (!rawPl || typeof rawPl !== "object") return {};
  const data = rawPl as {
    periods?: Array<{ pl?: Record<string, number> }>;
    aggregate?: Record<string, number>;
  };
  const periods = data.periods ?? [];
  if (periods.length > 0 && periods[0]?.pl && typeof periods[0].pl === "object") {
    return periods[0].pl;
  }
  if (data.aggregate && typeof data.aggregate === "object") {
    return data.aggregate;
  }
  // Flat P&L map (no periods wrapper)
  const { periods: _p, aggregate: _a, period_count: _pc, absurdity_warnings: _w, ...rest } = data as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(rest)) {
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

/**
 * The workbook's scale (e.g. "Crore") must travel with every figure handed
 * to the narrative LLM — without it, a bare "₹28,488.46" gets its own
 * invented scale word in the write-up (typically "Million"), silently
 * understating the real figure by 100x.
 */
export async function resolveScenarioCurrency(
  scenarioId: string,
): Promise<{ symbol: string; unit: string }> {
  try {
    const r = await pool.query(
      `SELECT cc.context_data FROM company_context cc
       JOIN user_models um ON um.source_context_id = cc.context_id
       JOIN scenarios s ON s.model_version_hash = um.model_id::text
       WHERE s.scenario_id = $1 LIMIT 1`,
      [scenarioId],
    );
    const data = r.rows[0]?.context_data as Record<string, unknown> | undefined;
    const code = data?.currency as string | undefined;
    const unit = (data?.currency_unit as string) || "";
    if (!code) return { symbol: "$", unit };
    return { symbol: CURRENCY_SYMBOLS[code] || code || "$", unit };
  } catch {
    return { symbol: "$", unit: "" };
  }
}

function generateFallbackNarrative(input: NarrativeInput): string {
  const { scenario_name, nl_input, pl, parameters, audience } = input;
  const c = input.currency_symbol || "$";
  const u = input.currency_unit ? ` ${input.currency_unit}` : "";
  const title = scenario_name || "Scenario Analysis";
  const topImpacts = Object.entries(pl)
    .map(([k, v]) => ({ metric: k, value: v }))
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
    .slice(0, 3);

  const paramSummary = parameters
    .map((p) => `${p.name} (${p.direction} ${p.magnitude} ${p.unit})`)
    .join(", ");

  const intro =
    audience === "board"
      ? `**${title}** — This analysis evaluates the financial impact of the following scenario: "${nl_input}".`
      : `**${title}** — Scenario: "${nl_input}".`;

  const body = `Key assumptions: ${paramSummary || "none specified"}. ` +
    `The top P&L impacts are: ${topImpacts.map((t) => `**${t.metric}**: ${c}${t.value.toLocaleString()}${u}`).join(", ")}.`;

  const risk =
    audience === "board"
      ? "This is an AI-generated draft — review required. Sensitivity to individual assumptions should be evaluated before decision-making."
      : "AI-generated draft — review required.";

  return `${intro}\n\n${body}\n\n${risk}`;
}

export async function generateNarrative(input: NarrativeInput): Promise<string> {
  if (!getApiKey()) return generateFallbackNarrative(input);

  const c = input.currency_symbol || "$";
  const unitNote = input.currency_unit
    ? `\nEvery figure below is already in ${input.currency_unit} — cite it with that exact unit (e.g. "${c}1,234 ${input.currency_unit}"). Never append or infer a different scale word (Million/Billion/Lakh) and never convert the number.`
    : "";
  const tone = input.audience === "board" ? "formal, concise, suitable for a board presentation" : "professional, detailed, suitable for internal FP&A review";
  try {
    const parsed = await callClaudeStructured({
      system: `You are an FP&A analyst writing a 2-3 paragraph executive summary. Tone: ${tone}.
Use the currency symbol "${c}" for all monetary figures — never invent a different currency.${unitNote}
P&L figures are for a single period (or the first period of a multi-period run), not a multi-period aggregate.
Always end the narrative with: "AI-generated draft — review required."`,
      userMessage: `Scenario: "${input.nl_input}"
Parameters: ${JSON.stringify(input.parameters)}
P&L results (${c}${input.currency_unit ? `, in ${input.currency_unit}` : ""}): ${JSON.stringify(input.pl)}
Write a 2-3 paragraph executive summary describing assumptions, key impacts, and risks.`,
      schema: narrativeSchema,
      toolName: "submit_narrative",
      toolDescription: "Submit the executive summary narrative",
      maxTokens: 512,
      purpose: "narrative",
    });
    return parsed.narrative.trim() || generateFallbackNarrative(input);
  } catch {
    return generateFallbackNarrative(input);
  }
}
