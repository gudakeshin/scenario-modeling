/**
 * Reflection Service — LLM-based "thinking" loop for scenario analysis.
 *
 * Before the parser extracts parameters, the reflection agent reasons
 * through the scenario in natural language, grounded in the user's
 * company context and model definition.
 */

import { z } from "zod";
import { getApiKey, callClaudeStructured } from "./llmClient.js";
import { getUserModelDefinition, describeModelForLLM } from "../models/registry.js";
import { describeContextForLLM } from "./contextEngine.js";
import type { SearchResult } from "./searchService.js";
import { logger } from "../logger.js";

const reflectionSchema = z.object({
  thinking: z.string(),
  summary: z.object({
    intent: z.string(),
    affected_areas: z.array(z.string()).default([]),
    assumptions: z.array(z.string()).default([]),
    second_order_effects: z.array(z.string()).default([]),
    suggested_variables: z.array(z.string()).default([]),
  }),
});

export interface ReflectionResult {
  thinking: string;
  summary: {
    intent: string;
    affected_areas: string[];
    assumptions: string[];
    second_order_effects: string[];
    suggested_variables: string[];
  };
  duration_ms: number;
}

/**
 * Run the reflection/thinking loop on a scenario input.
 * Returns structured reasoning that can feed into the parser and be shown to the user.
 */
export async function reflect(
  nlInput: string,
  searchContext?: SearchResult | null,
  userId?: string
): Promise<ReflectionResult | null> {
  if (!getApiKey()) return null;

  const startTime = Date.now();

  try {
    // Load user's model and company context
    if (!userId) return null;
    const model = await getUserModelDefinition(userId);
    if (!model) return null; // No model = can't reflect meaningfully

    const modelDesc = describeModelForLLM(model);
    const contextDesc = await describeContextForLLM(userId);

    let contextBlock = "";
    if (contextDesc) {
      contextBlock += `\n\n${contextDesc}`;
    }
    if (searchContext?.summary) {
      contextBlock += `\n\nREAL-TIME RESEARCH:\n${searchContext.summary}`;
      if (searchContext.data_points.length > 0) {
        contextBlock += `\n\nKey data:\n${searchContext.data_points.slice(0, 6).map((d) => `• ${d}`).join("\n")}`;
      }
    }

    const systemPrompt = `You are a senior financial analyst thinking through a scenario modeling request.

Your job is to REASON STEP BY STEP about what the user is asking, before any parameters are extracted. Think out loud like a consultant analyzing a client request.

AVAILABLE MODEL:
${modelDesc}${contextBlock}

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

    const parsed = await callClaudeStructured({
      system: systemPrompt,
      userMessage: `Scenario: "${nlInput}"\n\nThink through this scenario step by step.`,
      schema: reflectionSchema,
      toolName: "submit_reflection",
      toolDescription: "Submit the step-by-step reasoning about this scenario",
      maxTokens: 800,
      temperature: 0.3,
      purpose: "reflection",
    });
    const duration = Date.now() - startTime;

    return {
      thinking: parsed.thinking,
      summary: parsed.summary,
      duration_ms: duration,
    };
  } catch (e) {
    logger.warn({ detail: (e as Error).message }, "[Reflection] Failed:");
    return null;
  }
}
