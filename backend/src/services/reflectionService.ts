/**
 * Reflection Service — LLM-based "thinking" loop for scenario analysis.
 *
 * Before the parser extracts parameters, the reflection agent reasons
 * through the scenario in natural language:
 *   - What is the user really asking?
 *   - What business areas are affected?
 *   - What assumptions am I making?
 *   - What second-order effects should be considered?
 *   - What model variables are relevant?
 *
 * The reflection serves two purposes:
 *   1. Improves parse quality by providing structured reasoning as context
 *   2. Is shown to the user as visible "thinking" (like ChatGPT's reasoning)
 */

import { getApiKey, callClaude } from "./llmClient.js";
import { getModelDefinition, describeModelForLLM } from "../models/registry.js";
import type { SearchResult } from "./searchService.js";

export interface ReflectionResult {
  /** The full chain-of-thought reasoning text */
  thinking: string;
  /** Structured summary for the parser to use */
  summary: {
    intent: string;
    affected_areas: string[];
    assumptions: string[];
    second_order_effects: string[];
    suggested_variables: string[];
  };
  /** Time taken for reflection (ms) */
  duration_ms: number;
}

/**
 * Run the reflection/thinking loop on a scenario input.
 * Returns structured reasoning that can feed into the parser and be shown to the user.
 */
export async function reflect(
  nlInput: string,
  searchContext?: SearchResult | null
): Promise<ReflectionResult | null> {
  if (!getApiKey()) return null;

  const startTime = Date.now();

  try {
    const model = await getModelDefinition();
    const modelDesc = describeModelForLLM(model);

    let contextBlock = "";
    if (searchContext?.summary) {
      contextBlock = `\n\nREAL-TIME RESEARCH:\n${searchContext.summary}`;
      if (searchContext.data_points.length > 0) {
        contextBlock += `\n\nKey data:\n${searchContext.data_points.slice(0, 6).map((d) => `• ${d}`).join("\n")}`;
      }
    }

    const systemPrompt = `You are a senior financial analyst thinking through a scenario modeling request.

Your job is to REASON STEP BY STEP about what the user is asking, before any parameters are extracted. Think out loud like a consultant analyzing a client request.

AVAILABLE MODEL:
${modelDesc}

OUTPUT FORMAT — return ONLY valid JSON (no markdown, no code fences):
{
  "thinking": "Your step-by-step reasoning in natural language. Write 3-6 sentences. Think through: (1) What is the user's core intent? (2) What P&L line items are directly affected? (3) What second-order effects might occur? (4) What assumptions am I making? (5) What data would make this more precise?",
  "summary": {
    "intent": "One-sentence summary of what the user wants to model",
    "affected_areas": ["revenue", "costs", ...],
    "assumptions": ["assumption 1", "assumption 2"],
    "second_order_effects": ["effect 1", "effect 2"],
    "suggested_variables": ["variable_id_1", "variable_id_2"]
  }
}

Be analytical, specific, and concise. Use the model variable IDs when referring to variables.`;

    const text = await callClaude({
      system: systemPrompt,
      userMessage: `Scenario: "${nlInput}"${contextBlock}\n\nThink through this scenario step by step. Return JSON only.`,
      maxTokens: 800,
      temperature: 0.3,
    });

    // Strip markdown code fences if present
    const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    const parsed = JSON.parse(cleaned);
    const duration = Date.now() - startTime;

    return {
      thinking: parsed.thinking || "",
      summary: {
        intent: parsed.summary?.intent || "",
        affected_areas: Array.isArray(parsed.summary?.affected_areas) ? parsed.summary.affected_areas : [],
        assumptions: Array.isArray(parsed.summary?.assumptions) ? parsed.summary.assumptions : [],
        second_order_effects: Array.isArray(parsed.summary?.second_order_effects) ? parsed.summary.second_order_effects : [],
        suggested_variables: Array.isArray(parsed.summary?.suggested_variables) ? parsed.summary.suggested_variables : [],
      },
      duration_ms: duration,
    };
  } catch (e) {
    console.warn("[Reflection] Failed:", (e as Error).message);
    return null;
  }
}
