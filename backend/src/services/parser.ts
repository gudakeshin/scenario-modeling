/**
 * Scenario Parser — LLM-first with minimal heuristic fallback.
 *
 * The parser's job is to understand the user's INTENT and extract
 * structured parameters. It uses the user's dynamically-built model
 * from uploaded documents — no hardcoded patterns or variable maps.
 *
 * Flow:
 *   1. Load the user's model + company context from the DB
 *   2. Check if input needs external research (macro/news events)
 *   3. If so, call Perplexity Search for real-time data
 *   4. If ANTHROPIC_API_KEY is set → use Claude LLM with model-aware prompt + search context
 *   5. Otherwise → basic regex extraction (only explicit numeric patterns)
 *   6. Always returns structured ParsedParameter[] + optional clarification + search context
 */

import { z } from "zod";
import { getApiKey, callClaudeStructured } from "./llmClient.js";
import { getWorkspaceModelDefinition, describeModelForLLM, type ModelDefinition } from "../models/registry.js";
import { describeContextForLLM } from "./contextEngine.js";
import type { Scope } from "../middleware/workspace.js";
import { needsExternalSearch, searchPerplexity, type SearchResult } from "./searchService.js";
import { reflect, type ReflectionResult } from "./reflectionService.js";
import { logger } from "../logger.js";

const llmParseResponseSchema = z.object({
  parameters: z.array(z.object({
    name: z.string(),
    variable_type: z.string(),
    direction: z.string(),
    magnitude: z.number().default(0),
    unit: z.string().default("percent"),
    scope: z.record(z.string()).default({}),
    confidence: z.number().min(0).max(1).default(0.5),
    suggested_variable_id: z.string().optional(),
  })).default([]),
  clarification_needed: z.string().nullable().optional(),
  follow_up_questions: z.array(z.object({
    id: z.string(),
    question: z.string(),
    options: z.array(z.object({ label: z.string(), value: z.string() })).default([]),
    allow_custom: z.boolean().default(true),
  })).nullable().optional(),
});

export interface ParsedParameter {
  name: string;
  variable_type: string;
  direction: string;
  magnitude: number;
  unit: string;
  scope: Record<string, string>;
  confidence: number;
  suggested_variable_id?: string;
}

export type DeltaType = "percent" | "absolute";

const DECREASE_DIRECTION_RE = /decreas|declin|drop|reduc|cut|lower|fall|shrink|delay|contract/i;

/**
 * Convert a parsed parameter into a signed, typed delta for storage.
 *  - direction "decrease"/"reduce"/... flips the sign (previously the sign
 *    was dropped, so "cut costs 10%" was simulated as a 10% INCREASE)
 *  - "set" always means an absolute value
 *  - unit "percent" (not "set") means a relative % change
 */
export function toTypedDelta(p: ParsedParameter): { value: number; delta_type: DeltaType } {
  const magnitude = p.magnitude != null && !isNaN(Number(p.magnitude)) ? Number(p.magnitude) : 0;
  const direction = (p.direction || "").toLowerCase();

  if (direction === "set") {
    return { value: magnitude, delta_type: "absolute" };
  }

  // Respect an explicit sign from the LLM; otherwise apply direction.
  const value = magnitude < 0 || !DECREASE_DIRECTION_RE.test(direction)
    ? magnitude
    : -Math.abs(magnitude);

  const delta_type: DeltaType = (p.unit || "").toLowerCase().startsWith("percent")
    ? "percent"
    : "absolute";
  return { value, delta_type };
}

export interface FollowUpQuestion {
  id: string;
  question: string;
  options: { label: string; value: string }[];
  allow_custom?: boolean;
}

export interface ParseResult {
  parameters: ParsedParameter[];
  clarification_needed?: string;
  follow_up_questions?: FollowUpQuestion[];
  reflection?: {
    thinking: string;
    intent: string;
    assumptions: string[];
    second_order_effects: string[];
    duration_ms: number;
  };
  search_context?: {
    query: string;
    summary: string;
    data_points: string[];
    sources: string[];
  };
  notices?: { type: "warning" | "info"; message: string }[];
}

// ── LLM-powered parsing ──

function buildSystemPrompt(modelDescription: string, contextDescription?: string | null): string {
  let prompt = `You are a financial scenario parser for an FP&A scenario modeling tool.

TASK: Extract ALL scenario parameters from natural language input. You must understand business intent, not just keywords.

${modelDescription}`;

  if (contextDescription) {
    prompt += `\n\n${contextDescription}`;
  }

  prompt += `

RULES:
1. Return ONLY valid JSON with this structure:
{
  "parameters": [...],
  "clarification_needed": "..." or null,
  "follow_up_questions": [...] or null
}
2. Each parameter has: name, variable_type, direction, magnitude, unit, scope (object), confidence (0-1), suggested_variable_id
3. CRITICAL — For "suggested_variable_id": ONLY map to INPUT variables from the model (those tagged [input, percent_delta]). NEVER create parameters for CALCULATED/OUTPUT variables (those tagged [output]). Calculated variables like gross_profit, ebitda, ebit, net_income, profit_before_tax, margins, etc. are automatically recomputed from their formulas — they must NOT be overridden.
4. When the user says "costs go up by 10%", map this to the specific INPUT cost variables (like employee_benefits_delivery, subcontracting_costs, etc.), NOT to calculated totals like cost_of_revenue or gross_profit.
5. variable_type: timeline_shift, cost_change, revenue_change, volume_change, price_change, margin_change, operational_change, or any descriptive type.
6. direction: increase, decrease, delay, accelerate, set, etc.
7. unit: percent, quarter, month, currency, units, basis_points, etc.
8. scope: contextual qualifiers like {"geography": "APAC"}, {"product": "enterprise"}, {"category": "raw_materials"}, etc.
9. confidence: 0-1. Set < 0.8 if the intent is ambiguous.
10. If a single statement implies MULTIPLE changes, extract EACH as a separate parameter but ONLY for INPUT variables.

FOLLOW-UP QUESTIONS:
10. When the input is ambiguous OR you can extract initial parameters but need more detail to be precise, generate "follow_up_questions". Each question has:
    - "id": short key (e.g. "severity", "geography", "timeline", "response_type")
    - "question": the question text
    - "options": array of {"label": display text, "value": a concise value string}
    - "allow_custom": true/false (whether user can type custom answer)
11. ALWAYS generate follow_up_questions when:
    - The scenario mentions a competitor action but not the expected impact magnitude
    - The scenario is qualitative and you're guessing at numbers
    - Multiple interpretations exist
    - Geography/product/timeline is unspecified for a scenario that would benefit from it
12. Extract your BEST-GUESS parameters AND ask clarifying questions simultaneously.
13. ALWAYS try to extract at least one parameter. Only return empty parameters if the input truly has no scenario content.
14. Understand common business language and map to the ACTUAL model variables provided above.`;

  return prompt;
}

async function llmParse(
  nlInput: string,
  scope: Scope | undefined,
  searchContext?: SearchResult | null,
  reflectionResult?: ReflectionResult | null
): Promise<ParseResult> {
  if (!getApiKey()) throw new Error("No API key");
  if (!scope) throw new Error("No user — authentication required");

  const model = await getWorkspaceModelDefinition(scope.workspaceId);
  if (!model) throw new Error("No model — onboarding needed");

  const modelDesc = describeModelForLLM(model);
  const contextDesc = await describeContextForLLM(scope);
  const systemPrompt = buildSystemPrompt(modelDesc, contextDesc);

  let userContent = `Scenario input: "${nlInput}"`;

  if (reflectionResult?.thinking) {
    userContent += `\n\n--- PRE-ANALYSIS REASONING ---\n${reflectionResult.thinking}`;
    if (reflectionResult.summary.affected_areas.length > 0) {
      userContent += `\nAffected areas: ${reflectionResult.summary.affected_areas.join(", ")}`;
    }
    if (reflectionResult.summary.suggested_variables.length > 0) {
      userContent += `\nSuggested variables: ${reflectionResult.summary.suggested_variables.join(", ")}`;
    }
    if (reflectionResult.summary.assumptions.length > 0) {
      userContent += `\nAssumptions: ${reflectionResult.summary.assumptions.join("; ")}`;
    }
    userContent += `\n--- END PRE-ANALYSIS ---\n\nIMPORTANT: Use the pre-analysis reasoning above to guide your parameter extraction. Be precise.`;
  }

  if (searchContext?.summary) {
    userContent += `\n\n--- REAL-TIME RESEARCH DATA (from web search) ---\n${searchContext.summary}`;
    if (searchContext.data_points.length > 0) {
      userContent += `\n\nKey quantitative data points:\n${searchContext.data_points.map((d) => `• ${d}`).join("\n")}`;
    }
    userContent += `\n--- END RESEARCH DATA ---\n
IMPORTANT: Use the research data above to derive SPECIFIC, QUANTITATIVE parameters.
Do NOT use generic estimates — use the actual numbers from the research.`;
  }
  userContent += "\n\nExtract ALL parameters. For each, suggest which model variable it maps to (suggested_variable_id).";

  const raw = await callClaudeStructured({
    system: systemPrompt,
    userMessage: userContent,
    schema: llmParseResponseSchema,
    toolName: "submit_scenario_parameters",
    toolDescription: "Submit the extracted scenario parameters and any follow-up questions",
    maxTokens: 4000,
    temperature: 0.2,
    purpose: "parse",
  });

  const parsed: ParseResult = {
    parameters: Array.isArray(raw.parameters) ? raw.parameters : [],
    clarification_needed: raw.clarification_needed ?? undefined,
    follow_up_questions: Array.isArray(raw.follow_up_questions) && raw.follow_up_questions.length > 0
      ? raw.follow_up_questions.map((q) => ({
          id: q.id || `q_${Math.random().toString(36).slice(2, 8)}`,
          question: q.question,
          options: Array.isArray(q.options) ? q.options : [],
          allow_custom: q.allow_custom !== false,
        }))
      : undefined,
  };

  if (searchContext) {
    parsed.search_context = {
      query: searchContext.query,
      summary: searchContext.summary,
      data_points: searchContext.data_points,
      sources: searchContext.sources,
    };
  }

  // Filter out parameters targeting calculated/output variables — only input vars should be overridden
  if (model && parsed.parameters.length > 0) {
    const outputVarIds = new Set(
      model.variables.filter((v) => v.tags?.includes("output")).map((v) => v.id)
    );
    const before = parsed.parameters.length;
    parsed.parameters = parsed.parameters.filter((p) => {
      if (p.suggested_variable_id && outputVarIds.has(p.suggested_variable_id)) {
        logger.info(`[Parser] Filtered out parameter for calculated variable: ${p.suggested_variable_id}`);
        return false;
      }
      return true;
    });
    if (before > parsed.parameters.length) {
      logger.info(`[Parser] Removed ${before - parsed.parameters.length} parameters targeting calculated variables`);
    }
  }

  if (parsed.parameters.length === 0 && !parsed.follow_up_questions?.length && !parsed.clarification_needed) {
    parsed.clarification_needed =
      "I couldn't extract clear parameters. Could you be more specific? For example: 'raw materials increase 8%' or 'delay APAC launch by one quarter'.";
  }

  return parsed;
}

// ── Minimal heuristic fallback (no hardcoded business scenarios) ──

const PCT_PATTERNS = [
  /(\w[\w\s]*?)\s+(?:increase|rise|grow|go\s*up)s?\s+(?:by\s+)?(\d+(?:\.\d+)?)\s*%/gi,
  /(\w[\w\s]*?)\s+(?:decrease|decline|drop|fall|go\s*down|cut|reduce)s?\s+(?:by\s+)?(\d+(?:\.\d+)?)\s*%/gi,
  /(\d+(?:\.\d+)?)\s*%\s+(?:increase|rise|growth)\s+(?:in\s+)?(\w[\w\s]*)/gi,
  /(\d+(?:\.\d+)?)\s*%\s+(?:decrease|decline|drop|reduction|cut)\s+(?:in\s+)?(\w[\w\s]*)/gi,
  /(?:increase|raise|boost|grow)\s+(\w[\w\s]*?)\s+(?:by\s+)?(\d+(?:\.\d+)?)\s*%/gi,
  /(?:decrease|reduce|cut|lower)\s+(\w[\w\s]*?)\s+(?:by\s+)?(\d+(?:\.\d+)?)\s*%/gi,
];

/**
 * Dynamically map a term to a model variable using the user's model.
 */
function dynamicGuessVariable(term: string, model: ModelDefinition | null): string | undefined {
  if (!model) return undefined;
  const lower = term.toLowerCase().trim();
  for (const v of model.variables) {
    if (v.id === lower) return v.id;
    if (v.name.toLowerCase() === lower) return v.id;
    if (lower.includes(v.id) || v.id.includes(lower)) return v.id;
    if (lower.includes(v.name.toLowerCase()) || v.name.toLowerCase().includes(lower)) return v.id;
  }
  return undefined;
}

function heuristicParse(nlInput: string, model: ModelDefinition | null): ParseResult {
  const parameters: ParsedParameter[] = [];

  // Only extract explicit numeric percentage patterns — no guessing
  for (const regex of PCT_PATTERNS) {
    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(nlInput)) !== null) {
      const isFirstNum = /^\d/.test(match[1]);
      const subject = isFirstNum ? match[2] : match[1];
      const magnitude = parseFloat(isFirstNum ? match[1] : match[2]);
      const isIncrease = /increase|rise|growth|raise|boost|grow|go\s*up/i.test(match[0]);
      const direction = isIncrease ? "increase" : "decrease";
      const suggestedId = dynamicGuessVariable(subject.trim(), model);

      if (suggestedId && parameters.some((p) => p.suggested_variable_id === suggestedId)) continue;

      parameters.push({
        name: `${subject.trim()} ${direction} ${magnitude}%`,
        variable_type: isIncrease ? "cost_increase" : "cost_decrease",
        direction,
        magnitude,
        unit: "percent",
        scope: { category: subject.trim().toLowerCase() },
        confidence: suggestedId ? 0.85 : 0.6,
        suggested_variable_id: suggestedId,
      });
    }
  }

  if (parameters.length === 0) {
    return {
      parameters: [],
      clarification_needed: model
        ? "I'd like to model this scenario but need more specifics. Try describing what changes, by how much, and in what area. For example:\n" +
          `- "${model.variables[0]?.name || "Revenue"} increase 10%"\n` +
          `- "${model.variables.find(v => v.tags?.includes("input"))?.name || "Costs"} decrease 5%"\n` +
          "- Or describe a business scenario for AI-powered analysis (requires API key)"
        : "No model has been created yet. Please upload your financial documents and build context first.",
    };
  }

  return { parameters };
}

// ── Main entry point ──

export async function parseScenario(nlInput: string, scope?: Scope): Promise<ParseResult> {
  const apiKey = getApiKey();
  const trimmed = nlInput.trim();
  const notices: { type: "warning" | "info"; message: string }[] = [];

  // Load the workspace's model for context (skip when no authenticated scope)
  let userModel: ModelDefinition | null = null;
  if (scope) {
    try {
      userModel = await getWorkspaceModelDefinition(scope.workspaceId);
    } catch {
      // If model lookup fails, continue — heuristic will guide user
    }
  }

  if (!userModel) {
    notices.push({
      type: "info",
      message: "No financial model found. Please upload documents and build your company context to enable scenario modeling.",
    });
  }

  const searchNeeded = needsExternalSearch(trimmed);

  // Step 1: Check if input needs real-time macro/news research
  let searchContext: SearchResult | null = null;
  if (searchNeeded) {
    const perplexityKey = process.env.PERPLEXITY_API_KEY;
    if (!perplexityKey) {
      logger.warn("[Parser] Perplexity key missing — search skipped");
      notices.push({
        type: "warning",
        message: "Real-time news/macro search is unavailable — PERPLEXITY_API_KEY is not configured. The system will use its built-in knowledge instead.",
      });
    } else {
      try {
        logger.info("[Parser] External research needed — calling Perplexity...");
        searchContext = await searchPerplexity(trimmed);
        if (searchContext) {
          logger.info(`[Parser] Perplexity returned ${searchContext.data_points.length} data points`);
        }
      } catch (e) {
        logger.warn({ detail: (e as Error).message }, "[Parser] Perplexity search failed:");
        notices.push({
          type: "warning",
          message: "Real-time search failed — proceeding with built-in knowledge.",
        });
      }
    }
  }

  // Step 2: Reflection / thinking loop
  let reflectionResult: ReflectionResult | null = null;
  let llmAvailable = false;
  if (apiKey && trimmed.length >= 5) {
    try {
      logger.info("[Parser] Running reflection loop...");
      reflectionResult = await reflect(trimmed, searchContext, scope);
      if (reflectionResult) {
        llmAvailable = true;
        logger.info(`[Parser] Reflection complete (${reflectionResult.duration_ms}ms)`);
      }
    } catch (e) {
      const errMsg = (e as Error).message;
      logger.warn({ detail: errMsg }, "[Parser] Reflection failed:");
      if (errMsg.includes("401") || errMsg.includes("invalid") || errMsg.includes("API key") || errMsg.includes("authentication")) {
        notices.push({
          type: "warning",
          message: "AI-powered analysis is unavailable — the Anthropic API key appears to be invalid. The system will use rule-based parsing instead.",
        });
      }
    }
  } else if (!apiKey) {
    notices.push({
      type: "warning",
      message: "AI-powered analysis is unavailable — ANTHROPIC_API_KEY is not configured. The system will use rule-based parsing.",
    });
  }

  // Step 3: LLM parse (enriched with reflection + search context)
  if (apiKey && trimmed.length >= 5) {
    try {
      const result = await llmParse(trimmed, scope, searchContext, reflectionResult);
      llmAvailable = true;

      if (reflectionResult) {
        result.reflection = {
          thinking: reflectionResult.thinking,
          intent: reflectionResult.summary.intent,
          assumptions: reflectionResult.summary.assumptions,
          second_order_effects: reflectionResult.summary.second_order_effects,
          duration_ms: reflectionResult.duration_ms,
        };
      }

      if (notices.length > 0) result.notices = notices;

      if (result.parameters.length > 0 || result.clarification_needed) {
        return result;
      }
    } catch (e) {
      const errMsg = (e as Error).message;
      logger.warn({ detail: errMsg }, "[Parser] LLM parse failed, falling back to heuristic:");
      if ((errMsg.includes("401") || errMsg.includes("invalid") || errMsg.includes("API key") || errMsg.includes("authentication")) && !notices.some((n) => n.message.includes("Anthropic API key"))) {
        notices.push({
          type: "warning",
          message: "AI-powered analysis is unavailable — the Anthropic API key appears to be invalid.",
        });
      }
    }
  }

  // Step 4: Fallback — minimal heuristic extraction (explicit numerics only)
  const heuristic = heuristicParse(trimmed, userModel);

  if (searchContext) {
    heuristic.search_context = {
      query: searchContext.query,
      summary: searchContext.summary,
      data_points: searchContext.data_points,
      sources: searchContext.sources,
    };
  }
  if (reflectionResult) {
    heuristic.reflection = {
      thinking: reflectionResult.thinking,
      intent: reflectionResult.summary.intent,
      assumptions: reflectionResult.summary.assumptions,
      second_order_effects: reflectionResult.summary.second_order_effects,
      duration_ms: reflectionResult.duration_ms,
    };
  }

  if (!llmAvailable && heuristic.parameters.length === 0 && searchNeeded) {
    heuristic.clarification_needed =
      "This looks like a macroeconomic or news-driven scenario that works best with AI-powered analysis.\n\n" +
      "**To get the best results:**\n" +
      "1. Add specific numbers based on your model variables\n" +
      "2. Configure API keys for full AI + real-time search capabilities\n\n" +
      "**The rule-based parser works with explicit inputs like:**\n" +
      `- "${userModel?.variables[0]?.name || "Revenue"} increase 10%"\n` +
      `- "${userModel?.variables.find(v => v.tags?.includes("input"))?.name || "Costs"} decrease 5%"`;
  }

  if (notices.length > 0) heuristic.notices = notices;
  return heuristic;
}
