import { getApiKey, callClaude } from "./llmClient.js";

export interface NarrativeInput {
  scenario_name: string | null;
  nl_input: string;
  pl: Record<string, number>;
  parameters: { name: string; direction: string; magnitude: number; unit: string }[];
  audience?: "board" | "internal";
}

function generateFallbackNarrative(input: NarrativeInput): string {
  const { scenario_name, nl_input, pl, parameters, audience } = input;
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
    `The top P&L impacts are: ${topImpacts.map((t) => `**${t.metric}**: $${t.value.toLocaleString()}`).join(", ")}.`;

  const risk =
    audience === "board"
      ? "This is an AI-generated draft — review required. Sensitivity to individual assumptions should be evaluated before decision-making."
      : "AI-generated draft — review required.";

  return `${intro}\n\n${body}\n\n${risk}`;
}

export async function generateNarrative(input: NarrativeInput): Promise<string> {
  if (!getApiKey()) return generateFallbackNarrative(input);

  const tone = input.audience === "board" ? "formal, concise, suitable for a board presentation" : "professional, detailed, suitable for internal FP&A review";
  try {
    const text = await callClaude({
      system: `You are an FP&A analyst writing a 2-3 paragraph executive summary. Tone: ${tone}. Always end with: "AI-generated draft — review required."`,
      userMessage: `Scenario: "${input.nl_input}"
Parameters: ${JSON.stringify(input.parameters)}
P&L results: ${JSON.stringify(input.pl)}
Write a 2-3 paragraph executive summary describing assumptions, key impacts, and risks.`,
      maxTokens: 512,
    });
    return text || generateFallbackNarrative(input);
  } catch {
    return generateFallbackNarrative(input);
  }
}
