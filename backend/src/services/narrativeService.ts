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

export async function resolveScenarioCurrencySymbol(scenarioId: string): Promise<string> {
  try {
    const r = await pool.query(
      `SELECT cc.context_data FROM company_context cc
       JOIN user_models um ON um.source_context_id = cc.context_id
       JOIN scenarios s ON s.model_version_hash = um.model_id::text
       WHERE s.scenario_id = $1 LIMIT 1`,
      [scenarioId],
    );
    const code = (r.rows[0]?.context_data as Record<string, unknown>)?.currency as string | undefined;
    if (!code) return "$";
    return CURRENCY_SYMBOLS[code] || code || "$";
  } catch {
    return "$";
  }
}

function generateFallbackNarrative(input: NarrativeInput): string {
  const { scenario_name, nl_input, pl, parameters, audience } = input;
  const c = input.currency_symbol || "$";
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
    `The top P&L impacts are: ${topImpacts.map((t) => `**${t.metric}**: ${c}${t.value.toLocaleString()}`).join(", ")}.`;

  const risk =
    audience === "board"
      ? "This is an AI-generated draft — review required. Sensitivity to individual assumptions should be evaluated before decision-making."
      : "AI-generated draft — review required.";

  return `${intro}\n\n${body}\n\n${risk}`;
}

export async function generateNarrative(input: NarrativeInput): Promise<string> {
  if (!getApiKey()) return generateFallbackNarrative(input);

  const c = input.currency_symbol || "$";
  const tone = input.audience === "board" ? "formal, concise, suitable for a board presentation" : "professional, detailed, suitable for internal FP&A review";
  try {
    const parsed = await callClaudeStructured({
      system: `You are an FP&A analyst writing a 2-3 paragraph executive summary. Tone: ${tone}.
Use the currency symbol "${c}" for all monetary figures — never invent a different currency.
P&L figures are for a single period (or the first period of a multi-period run), not a multi-period aggregate.
Always end the narrative with: "AI-generated draft — review required."`,
      userMessage: `Scenario: "${input.nl_input}"
Parameters: ${JSON.stringify(input.parameters)}
P&L results (${c}): ${JSON.stringify(input.pl)}
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
