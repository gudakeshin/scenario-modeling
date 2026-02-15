/**
 * Scenario Parser — LLM-first with intelligent heuristic fallback.
 *
 * The parser's job is to understand the user's INTENT and extract
 * structured parameters. It is NOT limited to predefined categories.
 *
 * Flow:
 *   1. Check if input needs external research (macro/news events)
 *   2. If so, call Perplexity Search for real-time data
 *   3. If ANTHROPIC_API_KEY is set → use Claude LLM with model-aware prompt + search context
 *   4. Otherwise → smart heuristic extraction (NLP patterns, not rigid regex)
 *   5. Always returns structured ParsedParameter[] + optional clarification + search context
 */

import { getApiKey, callClaude } from "./llmClient.js";
import { getModelDefinition, describeModelForLLM } from "../models/registry.js";
import { needsExternalSearch, searchPerplexity, type SearchResult } from "./searchService.js";
import { reflect, type ReflectionResult } from "./reflectionService.js";

export interface ParsedParameter {
  name: string;
  variable_type: string;
  direction: string;
  magnitude: number;
  unit: string;
  scope: Record<string, string>;
  confidence: number;
  /** Optional: the parser's best guess at which model variable this maps to */
  suggested_variable_id?: string;
}

/** A structured follow-up question to ask the user for disambiguation */
export interface FollowUpQuestion {
  /** Unique key for this question (e.g. "impact_severity", "geography") */
  id: string;
  /** The question text to display */
  question: string;
  /** Pre-defined answer options the user can click */
  options: { label: string; value: string }[];
  /** Whether the user can also type a custom answer (default true) */
  allow_custom?: boolean;
}

export interface ParseResult {
  parameters: ParsedParameter[];
  clarification_needed?: string;
  /** Structured follow-up questions when the system needs more info */
  follow_up_questions?: FollowUpQuestion[];
  /** LLM reflection/thinking — visible reasoning before parameter extraction */
  reflection?: {
    thinking: string;
    intent: string;
    assumptions: string[];
    second_order_effects: string[];
    duration_ms: number;
  };
  /** If external search was performed, the research context is attached */
  search_context?: {
    query: string;
    summary: string;
    data_points: string[];
    sources: string[];
  };
  /** User-facing notices about degraded features or configuration issues */
  notices?: { type: "warning" | "info"; message: string }[];
}

// ── LLM-powered parsing ──

function buildSystemPrompt(modelDescription: string): string {
  return `You are a financial scenario parser for an FP&A scenario modeling tool.

TASK: Extract ALL scenario parameters from natural language input. You must understand business intent, not just keywords.

${modelDescription}

RULES:
1. Return ONLY valid JSON with this structure:
{
  "parameters": [...],
  "clarification_needed": "..." or null,
  "follow_up_questions": [...] or null
}
2. Each parameter has: name, variable_type, direction, magnitude, unit, scope (object), confidence (0-1), suggested_variable_id
3. For "suggested_variable_id": map to the model variable IDs listed above. If the user says "raw materials increase 8%", map to "raw_material_cost". If they say "sell more units", map to "units_sold". If they say "raise prices", map to "unit_price". Use your judgment.
4. variable_type: timeline_shift, cost_change, revenue_change, volume_change, price_change, margin_change, operational_change, or any descriptive type.
5. direction: increase, decrease, delay, accelerate, set, etc.
6. unit: percent, quarter, month, currency, units, basis_points, etc.
7. scope: contextual qualifiers like {"geography": "APAC"}, {"product": "enterprise"}, {"category": "raw_materials"}, etc.
8. confidence: 0-1. Set < 0.8 if the intent is ambiguous.
9. If a single statement implies MULTIPLE changes (e.g. "cut costs by 10%" could affect both raw materials and opex), extract EACH as a separate parameter.

FOLLOW-UP QUESTIONS:
10. When the input is ambiguous OR you can extract initial parameters but need more detail to be precise, generate "follow_up_questions". Each question has:
    - "id": short key (e.g. "severity", "geography", "timeline", "response_type")
    - "question": the question text
    - "options": array of {"label": display text, "value": a concise value string}
    - "allow_custom": true/false (whether user can type custom answer)
11. ALWAYS generate follow_up_questions when:
    - The scenario mentions a competitor action but not the expected impact magnitude
    - The scenario is qualitative (e.g. "recession", "lose a client") and you're guessing at numbers
    - Multiple interpretations exist (e.g. "costs increase" — which costs?)
    - Geography/product/timeline is unspecified for a scenario that would benefit from it
12. Extract your BEST-GUESS parameters AND ask clarifying questions simultaneously. Don't wait — give initial estimates with lower confidence and ask for refinement.
13. ALWAYS try to extract at least one parameter. Only return empty parameters if the input truly has no scenario content.
14. Understand common business language:
    - "what if we lose a key client" → revenue decrease + ask: how large is the client? which segment?
    - "competitor launches cheaper product" → price pressure + volume risk + ask: by how much cheaper? which market?
    - "supply chain disruption" → raw material cost increase + ask: severity? duration?
    - "competitive pressure" → price decrease or volume decrease + ask: which product line?
    - "expansion into new market" → volume increase + opex increase + ask: which market? timeline?
    - "recession scenario" → revenue decrease + volume decrease + ask: mild/moderate/severe?
    - "cost optimization" → opex decrease or cogs decrease
    - "inflation impact" → cost increases across categories`;
}

async function llmParse(
  nlInput: string,
  searchContext?: SearchResult | null,
  reflectionResult?: ReflectionResult | null
): Promise<ParseResult> {
  if (!getApiKey()) throw new Error("No API key");

  const model = await getModelDefinition();
  const modelDesc = describeModelForLLM(model);
  const systemPrompt = buildSystemPrompt(modelDesc);

  // Build user message — enriched with reflection + Perplexity research
  let userContent = `Scenario input: "${nlInput}"`;

  // Inject reflection reasoning to improve parameter extraction
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
    userContent += `\n--- END PRE-ANALYSIS ---\n\nIMPORTANT: Use the pre-analysis reasoning above to guide your parameter extraction. The reasoning identifies which areas are affected and what variables to target. Be precise.`;
  }

  if (searchContext?.summary) {
    userContent += `\n\n--- REAL-TIME RESEARCH DATA (from web search) ---\n${searchContext.summary}`;
    if (searchContext.data_points.length > 0) {
      userContent += `\n\nKey quantitative data points:\n${searchContext.data_points.map((d) => `• ${d}`).join("\n")}`;
    }
    userContent += `\n--- END RESEARCH DATA ---\n
IMPORTANT: Use the research data above to derive SPECIFIC, QUANTITATIVE parameters.
Do NOT use generic estimates — use the actual numbers from the research.
For example, if the research says "inflation is 3.2%", use 3.2 as the magnitude, not a round number like 5%.
Map each data point to the most relevant model variable.`;
  }
  userContent += "\n\nExtract ALL parameters. For each, suggest which model variable it maps to (suggested_variable_id). Return JSON only — no markdown, no code fences.";

  const rawText = await callClaude({
    system: systemPrompt,
    userMessage: userContent,
    maxTokens: 2000,
    temperature: 0.2,
  });

  // Strip markdown code fences if present
  const text = rawText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  if (!text) throw new Error("Empty LLM response");

  const raw = JSON.parse(text) as ParseResult & { follow_up_questions?: FollowUpQuestion[] };
  const parsed: ParseResult = {
    parameters: Array.isArray(raw.parameters) ? raw.parameters : [],
    clarification_needed: raw.clarification_needed ?? undefined,
    follow_up_questions: Array.isArray(raw.follow_up_questions) && raw.follow_up_questions.length > 0
      ? raw.follow_up_questions.map((q) => ({
          id: q.id || `q_${Math.random().toString(36).slice(2, 8)}`,
          question: q.question,
          options: Array.isArray(q.options) ? q.options : [],
          allow_custom: q.allow_custom !== false, // default true
        }))
      : undefined,
  };

  // Attach search context to result if it was used
  if (searchContext) {
    parsed.search_context = {
      query: searchContext.query,
      summary: searchContext.summary,
      data_points: searchContext.data_points,
      sources: searchContext.sources,
    };
  }

  // If no parameters at all and no follow-ups, add a generic clarification
  if (parsed.parameters.length === 0 && !parsed.follow_up_questions?.length && !parsed.clarification_needed) {
    parsed.clarification_needed =
      "I couldn't extract clear parameters. Could you be more specific? For example: 'raw materials increase 8%' or 'delay APAC launch by one quarter'.";
  }

  return parsed;
}

// ── Smart heuristic fallback ──

// Pattern library — much broader than before
const PATTERNS = {
  // Percentage changes: "X% increase in Y", "Y increases by X%", "increase Y by X%"
  pctChange: [
    /(\w[\w\s]*?)\s+(?:increase|rise|grow|go\s*up)s?\s+(?:by\s+)?(\d+(?:\.\d+)?)\s*%/gi,
    /(\w[\w\s]*?)\s+(?:decrease|decline|drop|fall|go\s*down|cut|reduce)s?\s+(?:by\s+)?(\d+(?:\.\d+)?)\s*%/gi,
    /(\d+(?:\.\d+)?)\s*%\s+(?:increase|rise|growth)\s+(?:in\s+)?(\w[\w\s]*)/gi,
    /(\d+(?:\.\d+)?)\s*%\s+(?:decrease|decline|drop|reduction|cut)\s+(?:in\s+)?(\w[\w\s]*)/gi,
    /(?:increase|raise|boost|grow)\s+(\w[\w\s]*?)\s+(?:by\s+)?(\d+(?:\.\d+)?)\s*%/gi,
    /(?:decrease|reduce|cut|lower)\s+(\w[\w\s]*?)\s+(?:by\s+)?(\d+(?:\.\d+)?)\s*%/gi,
  ],
  // Timeline: "delay X by Y quarters" (supports "one quarter", "two months", etc.)
  timeline: /(?:delay|postpone|push\s*back|defer|accelerate|advance)\s+([\w\s]+?)\s+(?:by\s+)?(\d+|one|two|three|four|five|six)\s*(quarter|month|week|year)s?/gi,
  // Absolute: "set X to Y", "X becomes Y"
  absolute: /(?:set|change)\s+([\w\s]+?)\s+(?:to|at)\s+\$?(\d[\d,]*(?:\.\d+)?)/gi,
  // Qualitative → quantitative interpretation
  qualitative: [
    { pattern: /(?:lose|losing)\s+(?:a\s+)?(?:key|major|big)\s+(?:client|customer|account)/i, params: [{ name: "Revenue loss from key client", variable_type: "revenue_change", direction: "decrease", magnitude: 15, unit: "percent", scope: { reason: "client_loss" }, confidence: 0.75 }] },
    { pattern: /supply\s*chain\s+(?:disruption|issue|crisis|shock)/i, params: [{ name: "Supply chain cost increase", variable_type: "cost_change", direction: "increase", magnitude: 20, unit: "percent", scope: { category: "raw_materials" }, confidence: 0.7, suggested_variable_id: "raw_material_cost" }] },
    { pattern: /(?:recession|economic\s+downturn|market\s+crash)/i, params: [{ name: "Revenue decline (recession)", variable_type: "revenue_change", direction: "decrease", magnitude: 15, unit: "percent", scope: { reason: "recession" }, confidence: 0.7, suggested_variable_id: "revenue" }, { name: "Volume decline (recession)", variable_type: "volume_change", direction: "decrease", magnitude: 10, unit: "percent", scope: { reason: "recession" }, confidence: 0.65, suggested_variable_id: "units_sold" }] },
    { pattern: /competitive\s+pressure/i, params: [{ name: "Price reduction (competitive)", variable_type: "price_change", direction: "decrease", magnitude: 10, unit: "percent", scope: { reason: "competition" }, confidence: 0.7, suggested_variable_id: "unit_price" }] },
    { pattern: /(?:expansion|expand|enter)\s+(?:into\s+)?(?:new|additional)\s+market/i, params: [{ name: "Volume increase (new market)", variable_type: "volume_change", direction: "increase", magnitude: 20, unit: "percent", scope: { reason: "expansion" }, confidence: 0.7, suggested_variable_id: "units_sold" }, { name: "OpEx increase (expansion costs)", variable_type: "cost_change", direction: "increase", magnitude: 15, unit: "percent", scope: { reason: "expansion" }, confidence: 0.65, suggested_variable_id: "opex" }] },
    { pattern: /cost\s+(?:optimization|cutting|reduction|savings)/i, params: [{ name: "OpEx reduction", variable_type: "cost_change", direction: "decrease", magnitude: 10, unit: "percent", scope: { reason: "cost_optimization" }, confidence: 0.7, suggested_variable_id: "opex" }] },
    { pattern: /(?:inflation|inflationary)\s+(?:impact|pressure|environment)/i, params: [{ name: "Raw material inflation", variable_type: "cost_change", direction: "increase", magnitude: 8, unit: "percent", scope: { reason: "inflation" }, confidence: 0.7, suggested_variable_id: "raw_material_cost" }, { name: "OpEx inflation", variable_type: "cost_change", direction: "increase", magnitude: 5, unit: "percent", scope: { reason: "inflation" }, confidence: 0.65, suggested_variable_id: "opex" }] },
    { pattern: /(?:best|optimistic|bull)\s*(?:case|scenario)/i, params: [{ name: "Revenue growth (best case)", variable_type: "revenue_change", direction: "increase", magnitude: 20, unit: "percent", scope: { reason: "best_case" }, confidence: 0.65, suggested_variable_id: "revenue" }, { name: "Cost efficiency (best case)", variable_type: "cost_change", direction: "decrease", magnitude: 5, unit: "percent", scope: { reason: "best_case" }, confidence: 0.6, suggested_variable_id: "opex" }] },
    { pattern: /(?:worst|pessimistic|bear)\s*(?:case|scenario)/i, params: [{ name: "Revenue decline (worst case)", variable_type: "revenue_change", direction: "decrease", magnitude: 20, unit: "percent", scope: { reason: "worst_case" }, confidence: 0.65, suggested_variable_id: "revenue" }, { name: "Cost increase (worst case)", variable_type: "cost_change", direction: "increase", magnitude: 10, unit: "percent", scope: { reason: "worst_case" }, confidence: 0.6, suggested_variable_id: "raw_material_cost" }] },
  ],
};

// Term → model variable mapping (for heuristic mode)
const TERM_TO_VARIABLE: Record<string, string> = {
  revenue: "revenue", sales: "revenue", income: "revenue", "top line": "revenue",
  cost: "raw_material_cost", costs: "raw_material_cost", cogs: "cogs",
  "raw material": "raw_material_cost", "raw materials": "raw_material_cost", materials: "raw_material_cost",
  opex: "opex", "operating expense": "opex", "operating expenses": "opex", "operating cost": "opex",
  marketing: "opex", "sg&a": "opex", sga: "opex", overhead: "opex",
  price: "unit_price", pricing: "unit_price", prices: "unit_price",
  volume: "units_sold", units: "units_sold", demand: "units_sold", quantity: "units_sold",
  margin: "gross_margin", "gross margin": "gross_margin",
  ebitda: "ebitda", profit: "net_income", "net income": "net_income",
};

function guessVariable(termRaw: string): string | undefined {
  const term = termRaw.toLowerCase().trim();
  // Direct match
  if (TERM_TO_VARIABLE[term]) return TERM_TO_VARIABLE[term];
  // Partial match
  for (const [key, varId] of Object.entries(TERM_TO_VARIABLE)) {
    if (term.includes(key) || key.includes(term)) return varId;
  }
  return undefined;
}

function guessScope(nlInput: string): Record<string, string> {
  const scope: Record<string, string> = {};
  const geoMatch = /\b(apac|emea|latam|na|north\s*america|europe|asia|americas)\b/i.exec(nlInput);
  if (geoMatch) scope.geography = geoMatch[1].toLowerCase();
  const productMatch = /\b(enterprise|smb|consumer|b2b|b2c|premium|standard)\b/i.exec(nlInput);
  if (productMatch) scope.product = productMatch[1].toLowerCase();
  return scope;
}

function heuristicParse(nlInput: string): ParseResult {
  const parameters: ParsedParameter[] = [];
  const globalScope = guessScope(nlInput);

  // 1. Try qualitative patterns first (business scenarios)
  for (const q of PATTERNS.qualitative) {
    if (q.pattern.test(nlInput)) {
      for (const p of q.params) {
        parameters.push({ ...p, scope: { ...p.scope, ...globalScope } });
      }
    }
  }

  // 2. Extract percentage changes
  for (const regex of PATTERNS.pctChange) {
    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(nlInput)) !== null) {
      const isFirstNum = /^\d/.test(match[1]);
      const subject = isFirstNum ? match[2] : match[1];
      const magnitude = parseFloat(isFirstNum ? match[1] : match[2]);
      const isIncrease = /increase|rise|growth|raise|boost|grow|go\s*up/i.test(match[0]);
      const direction = isIncrease ? "increase" : "decrease";
      const suggestedId = guessVariable(subject.trim());

      // Dedup: skip if we already have a param with same variable
      if (suggestedId && parameters.some((p) => p.suggested_variable_id === suggestedId)) continue;

      parameters.push({
        name: `${subject.trim()} ${direction} ${magnitude}%`,
        variable_type: isIncrease ? "cost_increase" : "cost_decrease",
        direction,
        magnitude,
        unit: "percent",
        scope: { category: subject.trim().toLowerCase(), ...globalScope },
        confidence: suggestedId ? 0.85 : 0.7,
        suggested_variable_id: suggestedId,
      });
    }
  }

  // 3. Extract timeline shifts
  const WORD_NUMS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
  PATTERNS.timeline.lastIndex = 0;
  let timeMatch;
  while ((timeMatch = PATTERNS.timeline.exec(nlInput)) !== null) {
    const subject = timeMatch[1].trim();
    const rawMag = timeMatch[2].toLowerCase();
    const magnitude = WORD_NUMS[rawMag] ?? parseInt(rawMag, 10);
    const unit = timeMatch[3].toLowerCase();
    const isDelay = /delay|postpone|push|defer/i.test(timeMatch[0]);

    parameters.push({
      name: `${subject} ${isDelay ? "delay" : "acceleration"}`,
      variable_type: "timeline_shift",
      direction: isDelay ? "delay" : "accelerate",
      magnitude,
      unit,
      scope: { ...globalScope, subject: subject.toLowerCase() },
      confidence: 0.85,
      suggested_variable_id: guessVariable(subject),
    });
  }

  // 4. Extract absolute values
  PATTERNS.absolute.lastIndex = 0;
  let absMatch;
  while ((absMatch = PATTERNS.absolute.exec(nlInput)) !== null) {
    const subject = absMatch[1].trim();
    const value = parseFloat(absMatch[2].replace(/,/g, ""));
    parameters.push({
      name: `Set ${subject} to ${value}`,
      variable_type: "absolute_set",
      direction: "set",
      magnitude: value,
      unit: "currency",
      scope: { category: subject.toLowerCase(), ...globalScope },
      confidence: 0.8,
      suggested_variable_id: guessVariable(subject),
    });
  }

  if (parameters.length === 0) {
    return {
      parameters: [],
      clarification_needed:
        "I'd like to model this scenario but need more specifics. Try describing what changes, by how much, and in what area. For example:\n" +
        '- "What if raw materials increase 8% and we delay the APAC launch by one quarter?"\n' +
        '- "Revenue drops 15% due to losing a key client"\n' +
        '- "Supply chain disruption increases costs 20%"\n' +
        '- "Best case scenario with 20% revenue growth"',
    };
  }

  return { parameters };
}

// ── Main entry point ──

export async function parseScenario(nlInput: string): Promise<ParseResult> {
  const apiKey = getApiKey();
  const trimmed = nlInput.trim();
  const notices: { type: "warning" | "info"; message: string }[] = [];

  // Track which features needed real-time search
  const searchNeeded = needsExternalSearch(trimmed);

  // Step 1: Check if input needs real-time macro/news research
  let searchContext: SearchResult | null = null;
  if (searchNeeded) {
    const perplexityKey = process.env.PERPLEXITY_API_KEY;
    if (!perplexityKey) {
      console.warn("[Parser] Perplexity key missing — search skipped");
      notices.push({
        type: "warning",
        message: "Real-time news/macro search is unavailable — PERPLEXITY_API_KEY is not configured. The system will use its built-in knowledge instead. For live data, ask your admin to add a Perplexity API key.",
      });
    } else {
      try {
        console.log("[Parser] External research needed — calling Perplexity...");
        searchContext = await searchPerplexity(trimmed);
        if (searchContext) {
          console.log(`[Parser] Perplexity returned ${searchContext.data_points.length} data points`);
        }
      } catch (e) {
        console.warn("[Parser] Perplexity search failed, continuing without:", (e as Error).message);
        notices.push({
          type: "warning",
          message: "Real-time search failed — proceeding with built-in knowledge. Try again in a moment.",
        });
      }
    }
  }

  // Step 2: Reflection / thinking loop — reason through the scenario before extracting
  let reflectionResult: ReflectionResult | null = null;
  let llmAvailable = false;
  if (apiKey && trimmed.length >= 5) {
    try {
      console.log("[Parser] Running reflection loop...");
      reflectionResult = await reflect(trimmed, searchContext);
      if (reflectionResult) {
        llmAvailable = true; // If reflection succeeded, the API key works
        console.log(`[Parser] Reflection complete (${reflectionResult.duration_ms}ms)`);
      }
    } catch (e) {
      const errMsg = (e as Error).message;
      console.warn("[Parser] Reflection failed, continuing without:", errMsg);
      if (errMsg.includes("401") || errMsg.includes("invalid") || errMsg.includes("API key") || errMsg.includes("authentication")) {
        notices.push({
          type: "warning",
          message: "AI-powered analysis is unavailable — the Anthropic API key appears to be invalid. The system will use rule-based parsing instead, which works best with explicit inputs like \"raw materials increase 8%\". Update the API key for full AI capabilities.",
        });
      }
    }
  } else if (!apiKey) {
    notices.push({
      type: "warning",
      message: "AI-powered analysis is unavailable — ANTHROPIC_API_KEY is not configured. The system will use rule-based parsing, which works best with explicit inputs like \"revenue increase 10%\".",
    });
  }

  // Step 3: LLM parse (enriched with reflection + search context)
  if (apiKey && trimmed.length >= 5) {
    try {
      const result = await llmParse(trimmed, searchContext, reflectionResult);
      llmAvailable = true;

      // Attach reflection to result
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
      console.warn("[Parser] LLM parse failed, falling back to heuristic:", errMsg);
      // Only add the notice once (reflection may have already added it)
      if ((errMsg.includes("401") || errMsg.includes("invalid") || errMsg.includes("API key") || errMsg.includes("authentication")) && !notices.some((n) => n.message.includes("Anthropic API key"))) {
        notices.push({
          type: "warning",
          message: "AI-powered analysis is unavailable — the Anthropic API key appears to be invalid. The system will use rule-based parsing instead. Update the API key for full AI capabilities.",
        });
      }
    }
  }

  // Step 4: Fallback — smart heuristic extraction
  const heuristic = heuristicParse(trimmed);

  // Attach search context even for heuristic results so the frontend can display it
  if (searchContext) {
    heuristic.search_context = {
      query: searchContext.query,
      summary: searchContext.summary,
      data_points: searchContext.data_points,
      sources: searchContext.sources,
    };
  }
  // Attach reflection even for heuristic results
  if (reflectionResult) {
    heuristic.reflection = {
      thinking: reflectionResult.thinking,
      intent: reflectionResult.summary.intent,
      assumptions: reflectionResult.summary.assumptions,
      second_order_effects: reflectionResult.summary.second_order_effects,
      duration_ms: reflectionResult.duration_ms,
    };
  }

  // If we fell back to heuristic and input needed search or LLM, add a tip
  if (!llmAvailable && heuristic.parameters.length === 0 && searchNeeded) {
    // Replace generic clarification with a more helpful one for news/macro queries
    heuristic.clarification_needed =
      "This looks like a macroeconomic or news-driven scenario that works best with AI-powered analysis.\n\n" +
      "**To get the best results, you can:**\n" +
      "1. Add specific numbers: _\"Inflation causes raw materials increase 8% and opex increase 5%\"_\n" +
      "2. Configure API keys for full AI + real-time search capabilities\n\n" +
      "**The rule-based parser works well with explicit inputs like:**\n" +
      '- "Raw materials increase 8%"\n' +
      '- "Revenue drops 15% and costs go up 10%"\n' +
      '- "Delay APAC launch by one quarter"';
  }

  if (notices.length > 0) heuristic.notices = notices;
  return heuristic;
}
