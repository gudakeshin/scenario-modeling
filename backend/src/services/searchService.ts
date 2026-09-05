/**
 * Perplexity Search Service — real-time macro/news research for scenario modeling.
 *
 * Uses Perplexity's Sonar API (OpenAI-compatible) to search the web for
 * macroeconomic data, industry news, and financial events.
 *
 * The results are used to enrich the LLM parser with real-world context,
 * enabling the system to generate precise, evidence-based scenario parameters.
 */

import OpenAI from "openai";
import { logger } from "../logger.js";

export interface SearchResult {
  query: string;
  summary: string;
  /** Key data points extracted from the search */
  data_points: string[];
  /** Sources/citations from search results */
  sources: string[];
  /** Whether the search found relevant financial/macro data */
  has_quantitative_data: boolean;
}

const PERPLEXITY_BASE_URL = "https://api.perplexity.ai";

/**
 * Detect whether the user input refers to macroeconomic events, news,
 * or external market conditions that benefit from real-time search.
 */
export function needsExternalSearch(nlInput: string): boolean {
  const input = nlInput.toLowerCase();
  const SEARCH_TRIGGERS = [
    // Macro indicators
    /\b(?:inflation|cpi|gdp|interest\s*rates?|fed\s*(?:rate|raises?|funds?)|tariffs?|trade\s*war|sanctions)\b/,
    /\b(?:recession|stagflation|deflation|monetary\s*policy|fiscal\s*policy)\b/,
    /\b(?:unemployment|labor\s*market|wage\s*growth|consumer\s*spending)\b/,
    // Market/industry events
    /\b(?:oil\s*prices?|commodity|commodities|supply\s*chain\s*crisis|chip\s*shortage)\b/,
    /\b(?:stock\s*market|market\s*crash|bear\s*market|bull\s*market|correction)\b/,
    /\b(?:forex|exchange\s*rates?|currency|dollar|euro|yen)\b/,
    // News/current events
    /\b(?:latest|recent|current|news|announced|announcement|report)\b/,
    /\b(?:impact\s*of|effect\s*of|what\s*happened|what\s*if.*(?:happens|continues))\b/,
    // Specific events / regulations
    /\b(?:regulation|regulatory|policy\s*change|tax\s*reform|subsidy|stimulus)\b/,
    /\b(?:pandemic|covid|outbreak|geopolitical|war|conflict|election)\b/,
    /\b(?:climate|carbon\s*tax|green\s*energy|sustainability|esg)\b/,
    // Industry trends
    /\b(?:ai\s*impact|automation|digital\s*transformation|disruption|tech\s*layoffs)\b/,
    /\b(?:merger|acquisition|ipo|bankruptcy|default)\b/,
    // Competitor actions
    /\b(?:competitor|competitors|competition|rival|rivals)\b/,
    /\b(?:price\s*war|undercut|market\s*share\s*(?:loss|gain|shift)|competitive\s*(?:threat|advantage|landscape|move|response))\b/,
    /\b(?:new\s*entrant|substitute|disrupt(?:or|ive|ion))\b/,
    /\b(?:launch(?:ed|es|ing)?.*(?:product|service|platform)|product\s*launch)\b/,
    /\b(?:poach(?:ed|ing)?|talent\s*war|hiring\s*(?:spree|freeze))\b/,
    /\b(?:patent|intellectual\s*property|ip\s*(?:lawsuit|dispute|challenge))\b/,
  ];

  return SEARCH_TRIGGERS.some((re) => re.test(input));
}

/**
 * Detect open-ended / qualitative questions that benefit from the agentic
 * reasoning loop (vs. a direct %/absolute lever extraction).
 */
export function isOpenEndedQuestion(nlInput: string): boolean {
  const input = nlInput.toLowerCase().trim();
  if (!input || input.length < 8) return false;

  // Explicit numeric lever changes are the fast path — not open-ended.
  if (isExplicitLeverChange(nlInput)) return false;

  if (needsExternalSearch(input)) return true;

  const OPEN_ENDED = [
    /\bwhat\s+if\b/,
    /\bhow\s+(?:would|will|might|could)\b/,
    /\b(?:impact|effect|implications?)\s+of\b/,
    /\bmodel\s+(?:a|the|this)?\s*(?:scenario|case)\b/,
    /\b(?:best|worst|base)\s*case\b/,
    /\b(?:stress\s*test|sensitivity)\b/,
    /\b(?:qualitative|strateg(?:y|ic)|macro)\b/,
    /\b(?:explore|analyze|analyse|assess)\b/,
  ];
  return OPEN_ENDED.some((re) => re.test(input));
}

/**
 * True when the user stated an explicit percent/absolute lever change
 * suitable for the fast parser path (not a macro / open-ended narrative).
 */
export function isExplicitLeverChange(nlInput: string): boolean {
  const input = nlInput.trim();
  const hasNumeric =
    /\b\d+(?:\.\d+)?\s*%/.test(input) ||
    /\bset\s+[\w\s]+\s+to\s+-?\d+/i.test(input) ||
    /\b(?:by\s+)?\d+(?:\.\d+)?\b/.test(input);
  if (!hasNumeric) return false;

  // Macro / open framing with research triggers stays on the agentic path
  if (
    needsExternalSearch(input) &&
    /\b(?:what\s+if|how\s+(?:would|will|might|could)|impact\s+of|effect\s+of|model\s+a)\b/i.test(input)
  ) {
    return false;
  }

  return /\b(?:increases?|decreases?|raises?|cuts?|reduces?|boosts?|grows?|drops?|lowers?|sets?)\b/i.test(input);
}

/**
 * Search Perplexity for real-time macro/financial context.
 * Returns structured research that the parser can use.
 */
export async function searchPerplexity(nlInput: string): Promise<SearchResult | null> {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) {
    logger.warn("PERPLEXITY_API_KEY not set — skipping external search");
    return null;
  }

  const client = new OpenAI({
    apiKey,
    baseURL: PERPLEXITY_BASE_URL,
  });

  const searchQuery = buildSearchQuery(nlInput);

  try {
    const response = await client.chat.completions.create({
      model: process.env.PERPLEXITY_MODEL || "sonar",
      messages: [
        {
          role: "system",
          content: `You are a financial research analyst. Given a scenario question, search for the latest real-world data and provide:

1. A concise summary of the current situation (2-3 sentences)
2. Specific quantitative data points (percentages, rates, amounts) that are relevant
3. The time frame and geography of the data

Focus on:
- Current numerical values (e.g., "inflation is currently 3.2%", "oil prices rose 15% YoY")
- Trend direction and magnitude
- Consensus forecasts from reliable sources
- Industry-specific impacts where available
- For competitor actions: market share data, pricing moves, product launch timelines, revenue/growth figures
- For market events: direct P&L impact estimates from analyst reports

Be precise with numbers. Always cite the approximate time frame of data (e.g., "as of Q4 2025", "February 2026").`,
        },
        {
          role: "user",
          content: searchQuery,
        },
      ],
      max_tokens: 800,
      temperature: 0.1,
    });

    const content = response.choices[0]?.message?.content;
    if (!content) return null;

    // Extract data points (lines with numbers/percentages)
    const dataPoints = content
      .split(/\n/)
      .filter((line) => /\d+\.?\d*\s*%|\$[\d,.]+|\d+\.?\d*\s*(?:billion|million|trillion|bps|basis)/i.test(line))
      .map((line) => line.replace(/^[-*•]\s*/, "").trim())
      .filter(Boolean)
      .slice(0, 10);

    // Check if we got quantitative data
    const hasQuantitative = dataPoints.length > 0 ||
      /\d+\.?\d*\s*%/g.test(content);

    // Extract sources from Perplexity citations (if present in response)
    const sources: string[] = [];
    const citationMatches = content.match(/\[(\d+)\]/g);
    if (citationMatches) {
      sources.push(...new Set(citationMatches.map((c) => `Source ${c}`)));
    }
    // Also extract any URLs mentioned
    const urlMatches = content.match(/https?:\/\/[^\s)]+/g);
    if (urlMatches) {
      sources.push(...urlMatches.slice(0, 5));
    }

    return {
      query: searchQuery,
      summary: content,
      data_points: dataPoints,
      sources,
      has_quantitative_data: hasQuantitative,
    };
  } catch (e) {
    logger.error({ err: e }, "Perplexity search failed");
    return null;
  }
}

/**
 * Build an optimized search query from user input.
 * Adds financial context to make the search more targeted.
 */
function buildSearchQuery(nlInput: string): string {
  const input = nlInput.trim();

  // If input is already a well-formed question, use it directly with financial context
  if (/\?$/.test(input) || /^what\s+(if|would|is|are|happens)/i.test(input)) {
    return `${input}\n\nProvide specific quantitative financial data, percentages, and recent statistics that would help model the P&L impact of this scenario for a business.`;
  }

  // Otherwise, frame it as a research question
  return `What is the current financial and business impact of: "${input}"?\n\nProvide specific quantitative data (percentages, growth rates, cost impacts) from recent reports and analysis that would help model the P&L impact for a business. Include any consensus forecasts.`;
}
