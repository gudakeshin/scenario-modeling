/**
 * Context Engine — builds company/industry understanding from uploaded documents.
 *
 * Flow:
 *  1. Retrieve document chunks from Postgres for the user's documents
 *  2. Send representative chunks to Claude for structured extraction
 *  3. Store extracted context (company profile, industry, metrics) in company_context table
 *  4. Generate a dynamic ModelDefinition from the extracted financial structure
 *  5. Store the model in user_models table
 */

import { z } from "zod";
import { config } from "../config.js";
import { pool, resolveUserId } from "../db/index.js";
import { callClaudeStructured, getApiKey } from "./llmClient.js";
import type { ModelDefinition } from "../models/registry.js";
import { logger } from "../logger.js";

const financialMetricSchema = z.object({
  name: z.string(),
  variable_id: z.string(),
  description: z.string(),
  typical_value: z.number().optional(),
  unit: z.string(),
  metric_type: z.enum(["currency", "count", "percent", "ratio", "volume", "unknown"]).optional(),
  source_header: z.string().optional(),
  source_column: z.string().optional(),
  source_section: z.string().optional(),
  category: z.enum(["revenue", "cost", "margin", "expense", "income", "other"]),
  is_input: z.boolean(),
  formula: z.string().optional(),
  dependencies: z.array(z.string()).default([]),
});

const contextExtractionSchema = z.object({
  company_name: z.string(),
  industry: z.string(),
  currency: z.string().optional(),
  currency_unit: z.string().optional(),
  business_model: z.string(),
  revenue_streams: z.array(z.string()).default([]),
  financial_metrics: z.array(financialMetricSchema).min(1),
  competitive_landscape: z.string(),
  key_risks: z.array(z.string()).default([]),
  benchmarks: z.record(z.string()).default({}),
});

// ── Types ──

export interface CompanyContext {
  context_id: string;
  company_name: string | null;
  industry: string | null;
  context_data: ContextData;
  source_document_ids: string[];
  status: string;
  created_at: string;
  updated_at: string;
}

export interface ContextData {
  company_name: string;
  industry: string;
  currency?: string;
  currency_unit?: string;
  business_model: string;
  revenue_streams: string[];
  financial_metrics: FinancialMetric[];
  header_mapping_suggestions?: HeaderMappingSuggestion[];
  competitive_landscape: string;
  key_risks: string[];
  benchmarks: Record<string, string>;
}

export interface HeaderMappingSuggestion {
  header_pattern: string;
  inferred_metric_type: "currency" | "count" | "percent" | "ratio" | "volume" | "unknown";
  expected_unit: string;
  mapping_guidance: string;
  sample_variable_ids: string[];
}

export interface FinancialMetric {
  name: string;
  variable_id: string;
  description: string;
  typical_value?: number;
  unit: string;
  metric_type?: "currency" | "count" | "percent" | "ratio" | "volume" | "unknown";
  source_header?: string;
  source_column?: string;
  source_section?: string;
  category: "revenue" | "cost" | "margin" | "expense" | "income" | "other";
  is_input: boolean;
  formula?: string;
  dependencies?: string[];
}

interface DenominationHints {
  currency?: string;
  currency_unit?: string;
  evidence: string[];
}

// ── Context Building ──

/**
 * Build company context from all uploaded documents for a user.
 * Retrieves representative chunks, sends to Claude for extraction,
 * and stores the structured result.
 */
export async function buildContext(userIdentifier: string): Promise<CompanyContext> {
  const userId = await resolveUserId(userIdentifier);

  // 1. Get all ready documents for this user
  const docResult = await pool.query(
    "SELECT document_id, name, file_type, created_at FROM documents WHERE created_by = $1 AND status = 'ready' ORDER BY created_at",
    [userId]
  );
  const docs = docResult.rows;
  if (docs.length === 0) {
    throw new Error("No processed documents found. Please upload at least one document first.");
  }

  // 2. Retrieve ALL chunks for the user's documents in order to reconstruct full text.
  // Prioritize the most recently uploaded document (most likely to contain the P&L the user intends).
  // For large document sets, only include the most recent 2 documents to stay within token budget.
  const sortedDocs = [...docs].sort((a: { created_at: string }, b: { created_at: string }) =>
    new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );
  const docsToUse = sortedDocs.slice(0, 2);
  const docIds = docsToUse.map((d: { document_id: string }) => d.document_id);
  logger.info(
    { docs: docsToUse.map((d: { name: string; document_id: string }) => d.name).join(", ") },
    `[ContextEngine] Using ${docsToUse.length} documents (of ${docs.length} total)`
  );

  const { getDocumentChunksFromDb } = await import("./documentService.js");
  const allChunks = await getDocumentChunksFromDb(docIds);

  if (allChunks.length === 0) {
    throw new Error("Could not retrieve document content. Try re-uploading documents.");
  }

  // 3. Reconstruct full document text, preserving original order.
  // Group chunks by document, then join — newest documents first so they get priority within the char limit.
  const docTexts = new Map<string, string[]>();
  for (const chunk of allChunks) {
    if (!docTexts.has(chunk.document_name)) docTexts.set(chunk.document_name, []);
    docTexts.get(chunk.document_name)!.push(chunk.text);
  }

  // Order documents newest-first
  const docNameOrder = docsToUse.map((d: { name: string }) => d.name);
  const sortedDocNames = [...docTexts.keys()].sort((a, b) => {
    const ai = docNameOrder.indexOf(a);
    const bi = docNameOrder.indexOf(b);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });

  let fullText = "";
  for (const docName of sortedDocNames) {
    const texts = docTexts.get(docName) || [];
    fullText += `\n[Document: ${docName}]\n${texts.join("\n")}\n`;
  }

  // Allow larger budget and distribute coverage across documents/tabs/sheets.
  const MAX_CHARS = 60000;
  const chunkText = buildRepresentativeExcerpt(fullText, MAX_CHARS);
  const denomHints = detectDenominationHints(fullText);

  if (!getApiKey()) {
    throw new Error("ANTHROPIC_API_KEY is required for context extraction. Please configure it.");
  }

  const systemPrompt = `You are a financial analyst extracting structured company and industry context from document excerpts.

Analyze the excerpts and extract a JSON object. Return ONLY valid JSON (no markdown, no code fences).

CRITICAL RULES FOR VALUE EXTRACTION:
1. Read the EXACT numbers from the INCOME STATEMENT / PROFIT & LOSS section. Do NOT round, approximate, or convert units. If the document says revenue is 53,752 — use 53752 exactly.
2. The document header states the unit (e.g. "All figures in INR Million"). Use THAT exact currency and unit. Do NOT convert to Crore, Billion, or any other unit. If it says "Million", report in Million.
3. Extract values for the MOST RECENT period/year (typically the first numeric column).
4. Extract from the DETAILED P&L LINE ITEMS — look for rows like "TOTAL REVENUE FROM OPERATIONS", "TOTAL COST OF REVENUE", "GROSS PROFIT", "TOTAL OPERATING EXPENSES", "EBITDA", "EBIT", "TOTAL OTHER INCOME", "TOTAL FINANCE COSTS", "PROFIT BEFORE TAX", "TOTAL TAX EXPENSE", "PROFIT AFTER TAX / NET INCOME".
5. Do NOT extract from summary ratio tables or key metrics sections — use the ACTUAL income statement figures.
6. Build a complete P&L hierarchy: Revenue → Cost of Revenue → Gross Profit → Operating Expenses → EBITDA → EBIT → Other Income → Finance Costs → PBT → Tax → Net Income.
7. For sub-totals, use the document's stated total, not your own calculation.
8. IMPORTANT for multi-tab Excel files: review ALL relevant tabs/sheets (P&L, assumptions, product hierarchy, headcount, volumes), not just the first sheet.
9. Classify non-financial operational metrics correctly: headcount and volumes are NOT currency.
10. Denomination can appear in title, footnote, sheet note, column header, or nearby rows (e.g., "All figures in INR Mn", "Rs. in Lakhs", "USD in millions", "Amounts in Cr."). Use TABLE CONTEXT to infer unit.
11. Normalize denomination variants to canonical scale:
   - Million: million, millions, mn, m, mio
   - Billion: billion, billions, bn, b
   - Thousand: thousand, thousands, k
   - Crore: crore, crores, cr
   - Lakh: lakh, lakhs, lac, lacs

Required JSON structure:
{
  "company_name": "string",
  "industry": "string (e.g. 'Technology / SaaS')",
  "currency": "string — ISO currency code: 'INR', 'USD', 'EUR', 'GBP', etc.",
  "currency_unit": "string — the scale: 'Million', 'Thousand', 'Billion', 'Crore', 'Lakh'",
  "business_model": "brief description (1-2 sentences max)",
  "revenue_streams": ["stream1", "stream2"],
  "financial_metrics": [
    {
      "name": "Revenue",
      "variable_id": "revenue",
      "description": "Total revenue from operations",
      "typical_value": 53752,
      "unit": "INR Million",
      "metric_type": "currency",
      "source_header": "TOTAL REVENUE FROM OPERATIONS",
      "source_column": "FY 2024-25",
      "source_section": "REVENUE FROM OPERATIONS",
      "category": "revenue",
      "is_input": true,
      "formula": "53752",
      "dependencies": []
    }
  ],
  "competitive_landscape": "brief (1-2 sentences)",
  "key_risks": ["risk1", "risk2"],
  "benchmarks": {"metric": "value"}
}

Rules for financial_metrics:
- Include 10-15 key P&L line items covering the FULL income statement hierarchy
- MUST include: revenue, cost_of_revenue, gross_profit, operating_expenses, ebitda, depreciation_amortization, ebit/operating_profit, other_income, finance_costs, profit_before_tax, tax_expense, net_income
- CRITICAL UNIT RULE: NOT all metrics are currency. Infer metric_type and unit from row/header semantics:
  - currency: revenue, costs, profit, tax, depreciation, interest, capex
  - count: headcount, employees, stores, FTE
  - volume: units sold, volume, quantity, throughput
  - percent: margin %, growth %, attrition %, utilization %, rates
  - ratio: current ratio, debt-to-equity, turnover x
- For INPUT variables (leaf items like revenue, cost_of_revenue, etc.): is_input=true, formula is the EXACT value from the document as a string, dependencies=[]
- For CALCULATED variables (derived items like gross_profit, ebitda, net_income): is_input=false, formula uses other variable_ids (e.g. "revenue - cost_of_revenue"), dependencies list ALL referenced variable_ids
- Use snake_case for variable_id
- category must be one of: revenue, cost, margin, expense, income, other
- typical_value MUST be the EXACT number from the document, not an approximation`;

  const extracted = await callClaudeStructured({
    system: systemPrompt,
    userMessage: `Here is the full document text:\n\n${chunkText}\n\nDenomination hints detected from context scan (may include noisy candidates):\nCurrency candidate: ${denomHints.currency || "unknown"}\nUnit candidate: ${denomHints.currency_unit || "unknown"}\nEvidence:\n- ${denomHints.evidence.slice(0, 10).join("\n- ")}\n\nExtract company context and P&L structure from this document. Read the EXACT numbers for each line item — do NOT estimate or round. Look for TOTAL/SUMMARY rows (e.g. "TOTAL REVENUE FROM OPERATIONS", "TOTAL COST OF REVENUE", "PROFIT AFTER TAX / NET INCOME") and use those exact values.`,
    schema: contextExtractionSchema,
    toolName: "submit_company_context",
    toolDescription: "Submit the extracted company context and P&L structure",
    maxTokens: 4000,
    temperature: 0.1,
    purpose: "context_build",
  });

  // financial_metrics.min(1) in the schema already guarantees non-empty;
  // ContextData's optional fields (header_mapping_suggestions) are filled
  // in below by buildHeaderMappingSuggestions / normalizeMetricSemantics.
  const contextData: ContextData = extracted;
  applyDenominationFallback(contextData, denomHints);
  normalizeMetricSemantics(contextData);

  // 4. Store in company_context (upsert — one active context per user)
  // Deactivate any existing context
  await pool.query("UPDATE company_context SET status = 'superseded' WHERE created_by = $1 AND status = 'active'", [userId]);

  const ctxResult = await pool.query(
    `INSERT INTO company_context (created_by, company_name, industry, context_data, source_document_ids, status)
     VALUES ($1, $2, $3, $4, $5, 'active')
     RETURNING *`,
    [userId, contextData.company_name, contextData.industry, JSON.stringify(contextData), docIds]
  );
  const ctx = ctxResult.rows[0];

  // 5. Generate and store a dynamic model definition
  const modelDef = buildModelFromContext(contextData);

  // Deactivate existing models
  await pool.query("UPDATE user_models SET is_active = false WHERE created_by = $1 AND is_active = true", [userId]);

  await pool.query(
    `INSERT INTO user_models (created_by, name, model_definition, source_context_id, is_active)
     VALUES ($1, $2, $3, $4, true)`,
    [userId, `${contextData.company_name || "Company"} P&L Model`, JSON.stringify(modelDef), ctx.context_id]
  );

  return {
    context_id: ctx.context_id,
    company_name: ctx.company_name,
    industry: ctx.industry,
    context_data: contextData,
    source_document_ids: docIds,
    status: ctx.status,
    created_at: ctx.created_at,
    updated_at: ctx.updated_at,
  };
}

function buildRepresentativeExcerpt(fullText: string, maxChars: number): string {
  if (fullText.length <= maxChars) return fullText;
  const docBlocks = fullText.split(/\n(?=\[Document: )/g).filter(Boolean);
  if (docBlocks.length === 0) return fullText.slice(0, maxChars);

  const perDocBudget = Math.max(4000, Math.floor(maxChars / docBlocks.length));
  const excerpts = docBlocks.map((doc) => buildRepresentativeDocExcerpt(doc, perDocBudget));
  const combined = excerpts.join("\n");
  return combined.length <= maxChars ? combined : combined.slice(0, maxChars);
}

function buildRepresentativeDocExcerpt(docText: string, budget: number): string {
  if (docText.length <= budget) return docText;
  const sheetBlocks = docText.split(/\n(?=Sheet:\s)/g).filter(Boolean);

  if (sheetBlocks.length <= 1) {
    return takeDistributedSlices(docText, budget);
  }

  const perSheetBudget = Math.max(1200, Math.floor(budget / sheetBlocks.length));
  const sampledSheets = sheetBlocks.map((sheet) => takeDistributedSlices(sheet, perSheetBudget));
  const joined = sampledSheets.join("\n");
  return joined.length <= budget ? joined : joined.slice(0, budget);
}

function takeDistributedSlices(text: string, budget: number): string {
  if (text.length <= budget) return text;
  const part = Math.max(200, Math.floor(budget / 3));
  const start = text.slice(0, part);
  const midStart = Math.max(0, Math.floor(text.length / 2) - Math.floor(part / 2));
  const middle = text.slice(midStart, midStart + part);
  const end = text.slice(Math.max(0, text.length - part));
  return `${start}\n...\n${middle}\n...\n${end}`;
}

// ── Formula Validation & Repair ──────────────────────────────────────────────
// The LLM sometimes marks calculated metrics (net_income, ebitda, etc.) as
// inputs with formula "0". The helpers below detect and repair those cases so
// scenario changes propagate correctly through the P&L.

function isNumericFormula(formula: string | undefined): boolean {
  if (!formula) return true;
  return /^-?\d+(\.\d+)?$/.test(formula.trim());
}

const KNOWN_CALCULATED_FORMULAS: Record<string, { deps: string[]; formula: string }[]> = {
  cost_of_revenue: [
    { deps: ["employee_benefits_delivery", "subcontracting_costs", "travel_costs_delivery", "software_licenses_tools", "hosting_cloud_infrastructure"], formula: "employee_benefits_delivery + subcontracting_costs + travel_costs_delivery + software_licenses_tools + hosting_cloud_infrastructure" },
    { deps: ["employee_benefits_delivery", "subcontracting_costs"], formula: "employee_benefits_delivery + subcontracting_costs" },
    { deps: ["raw_materials", "direct_labor", "manufacturing_overhead"], formula: "raw_materials + direct_labor + manufacturing_overhead" },
  ],
  gross_profit: [
    { deps: ["revenue", "cogs"], formula: "revenue - cogs" },
    { deps: ["revenue", "cost_of_goods_sold"], formula: "revenue - cost_of_goods_sold" },
    { deps: ["revenue", "cost_of_revenue"], formula: "revenue - cost_of_revenue" },
    { deps: ["revenue", "direct_costs"], formula: "revenue - direct_costs" },
  ],
  operating_income: [
    { deps: ["gross_profit", "operating_expenses"], formula: "gross_profit - operating_expenses" },
    { deps: ["gross_profit", "opex"], formula: "gross_profit - opex" },
    { deps: ["revenue", "cogs", "operating_expenses"], formula: "revenue - cogs - operating_expenses" },
  ],
  ebit: [
    { deps: ["gross_profit", "operating_expenses"], formula: "gross_profit - operating_expenses" },
    { deps: ["operating_income"], formula: "operating_income" },
    { deps: ["ebitda", "depreciation_amortization"], formula: "ebitda - depreciation_amortization" },
  ],
  ebitda: [
    { deps: ["ebit", "depreciation_amortization"], formula: "ebit + depreciation_amortization" },
    { deps: ["gross_profit", "operating_expenses", "depreciation_amortization"], formula: "gross_profit - operating_expenses + depreciation_amortization" },
    { deps: ["operating_income", "depreciation", "amortization"], formula: "operating_income + depreciation + amortization" },
    { deps: ["operating_income", "depreciation_amortization"], formula: "operating_income + depreciation_amortization" },
    { deps: ["revenue", "cogs", "operating_expenses"], formula: "revenue - cogs - operating_expenses" },
    { deps: ["gross_profit", "operating_expenses"], formula: "gross_profit - operating_expenses" },
    { deps: ["revenue", "total_expenses"], formula: "revenue - total_expenses" },
  ],
  profit_before_tax: [
    { deps: ["operating_income", "interest_expense"], formula: "operating_income - interest_expense" },
    { deps: ["ebitda", "depreciation", "amortization", "interest_expense"], formula: "ebitda - depreciation - amortization - interest_expense" },
    { deps: ["ebitda", "depreciation_amortization", "interest_expense"], formula: "ebitda - depreciation_amortization - interest_expense" },
    { deps: ["operating_income"], formula: "operating_income" },
    { deps: ["ebitda"], formula: "ebitda" },
  ],
  net_income: [
    { deps: ["profit_before_tax", "tax_expense"], formula: "profit_before_tax - tax_expense" },
    { deps: ["profit_before_tax", "tax"], formula: "profit_before_tax - tax" },
    { deps: ["profit_before_tax", "income_tax"], formula: "profit_before_tax - income_tax" },
    { deps: ["operating_income", "tax_expense"], formula: "operating_income - tax_expense" },
    { deps: ["operating_income", "tax"], formula: "operating_income - tax" },
    { deps: ["ebitda", "depreciation_amortization", "interest_expense", "tax_expense"], formula: "ebitda - depreciation_amortization - interest_expense - tax_expense" },
    { deps: ["revenue", "total_expenses", "tax_expense"], formula: "revenue - total_expenses - tax_expense" },
    { deps: ["revenue", "total_expenses"], formula: "revenue - total_expenses" },
  ],
  net_profit: [
    { deps: ["profit_before_tax", "tax_expense"], formula: "profit_before_tax - tax_expense" },
    { deps: ["profit_before_tax", "tax"], formula: "profit_before_tax - tax" },
    { deps: ["operating_income", "tax_expense"], formula: "operating_income - tax_expense" },
    { deps: ["revenue", "total_expenses"], formula: "revenue - total_expenses" },
  ],
  total_expenses: [
    { deps: ["cogs", "operating_expenses"], formula: "cogs + operating_expenses" },
    { deps: ["cogs", "opex"], formula: "cogs + opex" },
    { deps: ["cost_of_goods_sold", "operating_expenses"], formula: "cost_of_goods_sold + operating_expenses" },
  ],
  ebitda_margin: [
    { deps: ["ebitda", "revenue"], formula: "(ebitda / revenue) * 100" },
  ],
  gross_margin: [
    { deps: ["gross_profit", "revenue"], formula: "(gross_profit / revenue) * 100" },
  ],
  operating_margin: [
    { deps: ["operating_income", "revenue"], formula: "(operating_income / revenue) * 100" },
  ],
  net_margin: [
    { deps: ["net_income", "revenue"], formula: "(net_income / revenue) * 100" },
  ],
};

const TYPICALLY_CALCULATED = new Set([
  "gross_profit", "operating_income", "ebitda", "ebitda_margin",
  "profit_before_tax", "net_income", "total_expenses",
  "gross_margin", "operating_margin", "net_margin",
  "net_profit", "operating_profit", "ebit",
  "cost_of_revenue", "cost_of_goods_sold", "cogs",
]);

function findKnownFormula(
  variableId: string,
  availableVars: Set<string>,
): { formula: string; deps: string[] } | null {
  // Hardcoded P&L formula map is demo scaffolding only — production models
  // must come from workbook graphs or LLM extraction.
  if (!config.DEMO_MODE) return null;
  const candidates = KNOWN_CALCULATED_FORMULAS[variableId];
  if (!candidates) return null;
  for (const c of candidates) {
    if (c.deps.every((d) => availableVars.has(d))) {
      return { formula: c.formula, deps: [...c.deps] };
    }
  }
  return null;
}

function buildFormulaFromDependencies(
  dependencies: string[],
  category: string,
  availableVars: Set<string>,
): { formula: string; deps: string[] } | null {
  const validDeps = dependencies.filter((d) => availableVars.has(d));
  if (validDeps.length === 0) return null;

  if (category === "margin" && validDeps.length === 2) {
    return { formula: `(${validDeps[0]} / ${validDeps[1]}) * 100`, deps: validDeps };
  }
  if (["cost", "expense"].includes(category)) {
    return { formula: validDeps.join(" + "), deps: validDeps };
  }
  if (validDeps.length >= 2) {
    return { formula: `${validDeps[0]} - ${validDeps.slice(1).join(" - ")}`, deps: validDeps };
  }
  return { formula: validDeps[0], deps: validDeps };
}

/**
 * Validate LLM-extracted metrics and repair broken formulas.
 *
 * Three repair passes:
 *  1. is_input=false with dependencies, but formula is a bare number → rebuild
 *  2. is_input=true for typically-calculated variables with 0/null value → convert
 *  3. is_input=false with dependencies, but formula doesn't reference any → rebuild
 */
function validateAndRepairMetrics(metrics: FinancialMetric[]): void {
  const varIds = new Set(metrics.map((m) => m.variable_id));

  for (const m of metrics) {
    const numeric = isNumericFormula(m.formula);

    // Pass 1: calculated variable with listed deps but formula is just a number
    if (!m.is_input && m.dependencies && m.dependencies.length > 0 && numeric) {
      const repaired =
        findKnownFormula(m.variable_id, varIds) ||
        buildFormulaFromDependencies(m.dependencies, m.category, varIds);
      if (repaired) {
        m.formula = repaired.formula;
        m.dependencies = repaired.deps;
        logger.info(`[ContextEngine] Repaired formula for ${m.variable_id}: ${m.formula}`);
      }
    }

    // Pass 2: marked as input but should be calculated — always try for TYPICALLY_CALCULATED vars
    if (m.is_input && TYPICALLY_CALCULATED.has(m.variable_id)) {
      const repaired = findKnownFormula(m.variable_id, varIds);
      if (repaired) {
        m.is_input = false;
        m.formula = repaired.formula;
        m.dependencies = repaired.deps;
        logger.info(
          `[ContextEngine] Converted ${m.variable_id} from input(${m.typical_value ?? 0}) to calculated: ${m.formula}`,
        );
      }
    }

    // Pass 3: formula exists but doesn't actually reference any of its listed deps
    if (!m.is_input && m.dependencies && m.dependencies.length > 0 && m.formula) {
      const formula = m.formula;
      const refsAnyDep = m.dependencies.some((d) =>
        new RegExp(`\\b${d.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(formula),
      );
      if (!refsAnyDep) {
        const repaired =
          findKnownFormula(m.variable_id, varIds) ||
          buildFormulaFromDependencies(m.dependencies, m.category, varIds);
        if (repaired) {
          m.formula = repaired.formula;
          m.dependencies = repaired.deps;
          logger.info(`[ContextEngine] Fixed detached formula for ${m.variable_id}: ${m.formula}`);
        }
      }
    }
  }
}

/**
 * Post-build sanity check: ensures key derived variables (ebitda, net_income, …)
 * have proper formula paths. Attempts one last repair using the full variable set.
 */
function sanityCheckVariables(
  variables: Array<{ id: string; name: string; formula: string; dependencies: string[]; tags: string[] }>,
): void {
  const varIds = new Set(variables.map((v) => v.id));

  for (const v of variables) {
    if (!v.tags.includes("output")) continue;
    if (!isNumericFormula(v.formula)) continue;

    const repaired = findKnownFormula(v.id, varIds);
    if (repaired) {
      v.formula = repaired.formula;
      v.dependencies = repaired.deps;
      v.tags = v.tags.filter((t) => t !== "input" && t !== "percent_delta");
      if (!v.tags.includes("output")) v.tags.push("output");
      logger.info(`[ContextEngine] Sanity-check repaired ${v.id}: ${v.formula}`);
    } else if (v.dependencies.length === 0) {
      logger.warn(
        `[ContextEngine] WARNING: output variable "${v.id}" has static formula "${v.formula}" — scenario changes won't propagate to it`,
      );
    }
  }
}

/**
 * Build a ModelDefinition from extracted financial metrics.
 */
function buildModelFromContext(ctx: ContextData): ModelDefinition {
  validateAndRepairMetrics(ctx.financial_metrics);

  const variables = ctx.financial_metrics.map((m) => ({
    id: m.variable_id,
    name: m.name,
    formula: m.is_input
      ? String(m.typical_value ?? 0)
      : (m.formula || "0"),
    dependencies: m.dependencies || [],
    tags: buildTags(m),
  }));

  // Inject missing dependency variables referenced in formulas but not present in the model.
  // Scans both the explicit dependencies array AND the formula text for variable references.
  const varIds = new Set(variables.map((v) => v.id));
  const missingVars = new Set<string>();
  for (const v of variables) {
    for (const dep of v.dependencies) {
      if (!varIds.has(dep)) missingVars.add(dep);
    }
    // Also scan formula text for references to identifiers not in the model
    const formulaRefs = v.formula.match(/\b[a-z][a-z0-9_]*\b/g) || [];
    for (const ref of formulaRefs) {
      if (!varIds.has(ref) && !missingVars.has(ref)) {
        missingVars.add(ref);
      }
    }
  }
  // Common default values for financial variables that LLM might reference but not extract
  const COMMON_DEFAULTS: Record<string, number> = {
    depreciation: 1200, amortization: 650, depreciation_amortization: 2250,
    tax_expense: 1885, tax: 1885, income_tax: 1885,
    interest_expense: 650, finance_costs: 650,
    other_income: 389, exceptional_items: 0,
  };

  for (const missing of missingVars) {
    const matchingMetric = ctx.financial_metrics.find((m) =>
      m.variable_id === missing || m.name.toLowerCase().replace(/[^a-z0-9]/g, "_").includes(missing)
    );
    const value = matchingMetric?.typical_value ?? COMMON_DEFAULTS[missing] ?? 0;
    const name = missing.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    variables.push({
      id: missing,
      name,
      formula: String(value),
      dependencies: [],
      tags: ["pl_metric", "input", "percent_delta"],
    });
    varIds.add(missing);
    logger.info(`[ContextEngine] Injected missing dependency variable: ${missing} = ${value}`);
  }
  // Also ensure dependencies arrays are complete — add any formula-referenced vars to deps
  for (const v of variables) {
    const formulaRefs = v.formula.match(/\b[a-z][a-z0-9_]*\b/g) || [];
    for (const ref of formulaRefs) {
      if (varIds.has(ref) && ref !== v.id && !v.dependencies.includes(ref)) {
        v.dependencies.push(ref);
      }
    }
  }

  // Ensure we have at least a basic P&L structure
  const essentials = [
    { id: "revenue", name: "Revenue", needsTag: "pl_metric" },
    { id: "net_income", name: "Net Income", needsTag: "pl_metric" },
  ];
  for (const e of essentials) {
    if (!varIds.has(e.id)) {
      // Try to find something similar
      const similar = variables.find((v) => v.id.includes(e.id) || v.name.toLowerCase().includes(e.id));
      if (!similar) {
        variables.push({
          id: e.id,
          name: e.name,
          formula: "0",
          dependencies: [],
          tags: [e.needsTag, "input", "percent_delta"],
        });
      }
    }
  }

  sanityCheckVariables(variables);

  const now = new Date();
  const qtr = Math.ceil((now.getMonth() + 1) / 3);
  const year = now.getFullYear();

  return {
    model_version: `ctx-${Date.now()}`,
    time_horizon: {
      start: `${year}-Q${qtr}`,
      end: `${year + 1}-Q${((qtr + 2) % 4) + 1}`,
      granularity: "quarterly",
    },
    variables,
  };
}

function buildTags(m: FinancialMetric): string[] {
  const tags: string[] = [];
  if (["revenue", "margin", "income", "expense", "cost"].includes(m.category)) {
    tags.push("pl_metric");
  }
  if (m.is_input) {
    tags.push("input", "percent_delta");
  } else {
    tags.push("output");
  }
  return tags;
}

function normalizeMetricSemantics(ctx: ContextData): void {
  const normalized = (ctx.financial_metrics || []).map((m) => {
    const inferred = inferMetricType(m);
    let unit = (m.unit || "").trim();
    if (!unit) {
      if (inferred === "currency") {
        unit = `${ctx.currency || "USD"}${ctx.currency_unit ? ` ${ctx.currency_unit}` : ""}`.trim();
      } else if (inferred === "percent") {
        unit = "%";
      } else if (inferred === "count") {
        unit = "count";
      } else if (inferred === "volume") {
        unit = "units";
      } else if (inferred === "ratio") {
        unit = "ratio";
      } else {
        unit = "value";
      }
    }
    return { ...m, metric_type: inferred, unit };
  });

  ctx.financial_metrics = normalized;
  ctx.header_mapping_suggestions = buildHeaderMappingSuggestions(normalized);
}

function applyDenominationFallback(ctx: ContextData, hints: DenominationHints): void {
  ctx.currency = normalizeCurrencyCode(ctx.currency || hints.currency);
  ctx.currency_unit = normalizeCurrencyUnit(ctx.currency_unit || hints.currency_unit);

  if (!ctx.currency) ctx.currency = "USD";
  if (!ctx.currency_unit) ctx.currency_unit = "Million";
}

function inferMetricType(m: FinancialMetric): "currency" | "count" | "percent" | "ratio" | "volume" | "unknown" {
  const text = `${m.name} ${m.variable_id} ${m.description} ${m.unit}`.toLowerCase();
  if (text.includes("%") || /\bmargin\b|\bgrowth\b|\battrition\b|\butilization\b|\brate\b/.test(text)) return "percent";
  if (/\bratio\b|\bturnover\b|\bper\b.*\b(revenue|employee|store)\b|\bdebt[- ]to[- ]equity\b/.test(text)) return "ratio";
  if (/\bheadcount\b|\bemployees?\b|\bfte\b|\bstores?\b|\boutlets?\b|\bpoints of sale\b/.test(text)) return "count";
  if (/\bvolume\b|\bunits sold\b|\bquantity\b|\bthroughput\b|\bshipments?\b/.test(text)) return "volume";
  if (/\binr\b|\busd\b|\beur\b|\bgbp\b|\bcrore\b|\blakh\b|\bmillion\b|\bbillion\b|\brevenue\b|\bcost\b|\bexpense\b|\bprofit\b|\bebit\b|\bebitda\b|\btax\b|\bdepreciation\b/.test(text)) return "currency";
  return "unknown";
}

function buildHeaderMappingSuggestions(metrics: FinancialMetric[]): HeaderMappingSuggestion[] {
  const byType = new Map<string, string[]>();
  for (const m of metrics) {
    const t = m.metric_type || "unknown";
    const arr = byType.get(t) || [];
    arr.push(m.variable_id);
    byType.set(t, arr);
  }
  const suggestions: HeaderMappingSuggestion[] = [];
  if (byType.has("currency")) {
    suggestions.push({
      header_pattern: "Revenue|Cost|Expense|Profit|EBITDA|EBIT|Tax|Income",
      inferred_metric_type: "currency",
      expected_unit: "Currency + scale (e.g. INR Million, USD Mn)",
      mapping_guidance: "Map these headers to monetary variables and keep document currency/unit without conversion.",
      sample_variable_ids: (byType.get("currency") || []).slice(0, 8),
    });
  }
  if (byType.has("count")) {
    suggestions.push({
      header_pattern: "Headcount|Employees|FTE|Stores|Outlets|Points of Sale",
      inferred_metric_type: "count",
      expected_unit: "Count",
      mapping_guidance: "Map to count dimensions; do not apply currency symbol.",
      sample_variable_ids: (byType.get("count") || []).slice(0, 8),
    });
  }
  if (byType.has("volume")) {
    suggestions.push({
      header_pattern: "Volume|Units Sold|Quantity|Shipments",
      inferred_metric_type: "volume",
      expected_unit: "Units",
      mapping_guidance: "Map to operational volume drivers used for demand/throughput scenarios.",
      sample_variable_ids: (byType.get("volume") || []).slice(0, 8),
    });
  }
  if (byType.has("percent")) {
    suggestions.push({
      header_pattern: "Margin %|Growth %|Attrition %|Utilization %|Rate %",
      inferred_metric_type: "percent",
      expected_unit: "%",
      mapping_guidance: "Store as percentage metrics; avoid currency formatting.",
      sample_variable_ids: (byType.get("percent") || []).slice(0, 8),
    });
  }
  if (byType.has("ratio")) {
    suggestions.push({
      header_pattern: "Current Ratio|Debt-to-Equity|Turnover (x)",
      inferred_metric_type: "ratio",
      expected_unit: "x or ratio",
      mapping_guidance: "Store as ratios used for diagnostics, not monetary drivers.",
      sample_variable_ids: (byType.get("ratio") || []).slice(0, 8),
    });
  }
  return suggestions;
}

function normalizeCurrencyCode(value?: string): string | undefined {
  if (!value) return undefined;
  const v = value.trim().toUpperCase();
  if (v.includes("INR") || v.includes("RS") || v.includes("RUPEE") || v.includes("₹")) return "INR";
  if (v.includes("USD") || v.includes("US$") || v.includes("$")) return "USD";
  if (v.includes("EUR") || v.includes("€")) return "EUR";
  if (v.includes("GBP") || v.includes("£")) return "GBP";
  if (v.includes("AED")) return "AED";
  if (v.includes("SGD")) return "SGD";
  return v.length <= 5 ? v : undefined;
}

function normalizeCurrencyUnit(value?: string): string | undefined {
  if (!value) return undefined;
  const v = value.trim().toLowerCase();
  if (/\bmillion\b|\bmillions\b|\bmn\b|\bmio\b/.test(v)) return "Million";
  if (/\bbillion\b|\bbillions\b|\bbn\b/.test(v)) return "Billion";
  if (/\bthousand\b|\bthousands\b|\bk\b/.test(v)) return "Thousand";
  if (/\bcrore\b|\bcrores\b|\bcr\b/.test(v)) return "Crore";
  if (/\blakh\b|\blakhs\b|\blac\b|\blacs\b/.test(v)) return "Lakh";
  return undefined;
}

function detectDenominationHints(text: string): DenominationHints {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const currencyScore = new Map<string, number>();
  const unitScore = new Map<string, number>();
  const evidence: string[] = [];

  const addScore = (map: Map<string, number>, key: string, weight: number) => {
    map.set(key, (map.get(key) || 0) + weight);
  };

  for (const line of lines) {
    const lower = line.toLowerCase();
    const isHintLine = /\ball figures in\b|\bfigures in\b|\bamounts? in\b|\bcurrency\b|\bdenomination\b|\bunit\b/.test(lower);
    const weight = isHintLine ? 5 : 1;

    if (/\binr\b|₹|\brupees?\b|\brs\.?\b/.test(lower)) addScore(currencyScore, "INR", weight);
    if (/\busd\b|\bus\$\b|\$/.test(line)) addScore(currencyScore, "USD", weight);
    if (/\beur\b|€/.test(line)) addScore(currencyScore, "EUR", weight);
    if (/\bgbp\b|£/.test(line)) addScore(currencyScore, "GBP", weight);
    if (/\baed\b/.test(lower)) addScore(currencyScore, "AED", weight);
    if (/\bsgd\b/.test(lower)) addScore(currencyScore, "SGD", weight);

    if (/\bmillion\b|\bmillions\b|\bmn\b|\bmio\b/.test(lower)) addScore(unitScore, "Million", weight);
    if (/\bbillion\b|\bbillions\b|\bbn\b/.test(lower)) addScore(unitScore, "Billion", weight);
    if (/\bthousand\b|\bthousands\b/.test(lower)) addScore(unitScore, "Thousand", weight);
    if (/\bcrore\b|\bcrores\b|\bcr\b/.test(lower)) addScore(unitScore, "Crore", weight);
    if (/\blakh\b|\blakhs\b|\blac\b|\blacs\b/.test(lower)) addScore(unitScore, "Lakh", weight);

    if (isHintLine && evidence.length < 15) evidence.push(line);
  }

  const top = (map: Map<string, number>) =>
    [...map.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];

  return {
    currency: top(currencyScore),
    currency_unit: top(unitScore),
    evidence,
  };
}

// ── Context Retrieval ──

export async function getActiveContext(userIdentifier: string): Promise<CompanyContext | null> {
  const userId = await resolveUserId(userIdentifier);
  const r = await pool.query(
    "SELECT * FROM company_context WHERE created_by = $1 AND status = 'active' ORDER BY created_at DESC LIMIT 1",
    [userId]
  );
  if (r.rows.length === 0) return null;
  return r.rows[0];
}

export async function getActiveModel(userIdentifier: string): Promise<{ model_id: string; name: string; model_definition: ModelDefinition; is_active: boolean } | null> {
  const userId = await resolveUserId(userIdentifier);
  const r = await pool.query(
    "SELECT * FROM user_models WHERE created_by = $1 AND is_active = true ORDER BY created_at DESC LIMIT 1",
    [userId]
  );
  if (r.rows.length === 0) return null;
  return r.rows[0];
}

export async function updateContext(contextId: string, updates: Partial<ContextData>): Promise<CompanyContext> {
  const existing = await pool.query("SELECT * FROM company_context WHERE context_id = $1", [contextId]);
  if (existing.rows.length === 0) throw new Error("Context not found");
  const merged = { ...existing.rows[0].context_data, ...updates };
  await pool.query(
    "UPDATE company_context SET context_data = $1, company_name = $2, industry = $3, updated_at = NOW() WHERE context_id = $4",
    [JSON.stringify(merged), merged.company_name || existing.rows[0].company_name, merged.industry || existing.rows[0].industry, contextId]
  );
  const r = await pool.query("SELECT * FROM company_context WHERE context_id = $1", [contextId]);
  return r.rows[0];
}

export async function updateModel(modelId: string, modelDefinition: ModelDefinition): Promise<void> {
  await pool.query(
    "UPDATE user_models SET model_definition = $1, updated_at = NOW() WHERE model_id = $2",
    [JSON.stringify(modelDefinition), modelId]
  );
}

export async function deleteContext(userIdentifier: string): Promise<void> {
  const userId = await resolveUserId(userIdentifier);
  await pool.query("UPDATE company_context SET status = 'deleted' WHERE created_by = $1 AND status = 'active'", [userId]);
  await pool.query("UPDATE user_models SET is_active = false WHERE created_by = $1 AND is_active = true", [userId]);
}

/**
 * Build a text description of the company context for injection into LLM prompts.
 */
export async function describeContextForLLM(userIdentifier: string): Promise<string | null> {
  const ctx = await getActiveContext(userIdentifier);
  if (!ctx) return null;
  const d = ctx.context_data as ContextData;
  const lines = [
    `COMPANY CONTEXT:`,
    `Company: ${d.company_name || "Unknown"}`,
    `Industry: ${d.industry || "Unknown"}`,
    `Business Model: ${d.business_model || "Unknown"}`,
  ];
  if (d.revenue_streams?.length) {
    lines.push(`Revenue Streams: ${d.revenue_streams.join(", ")}`);
  }
  if (d.competitive_landscape) {
    lines.push(`Competitive Landscape: ${d.competitive_landscape}`);
  }
  if (d.key_risks?.length) {
    lines.push(`Key Risks: ${d.key_risks.join("; ")}`);
  }
  if (d.benchmarks && Object.keys(d.benchmarks).length > 0) {
    lines.push(`Industry Benchmarks: ${Object.entries(d.benchmarks).map(([k, v]) => `${k}: ${v}`).join(", ")}`);
  }
  return lines.join("\n");
}
