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
import type { ModelDefinition, ModelVariable } from "../models/registry.js";
import type { Scope } from "../middleware/workspace.js";
import { logger } from "../logger.js";
import { CompiledModel, compileFormula } from "./expression.js";
import { inferMetricTypeFromId, type MetricType, type VariableProvenance } from "./metricTypes.js";
import { crossFootExtractedPL, applyTieOutGate, type TieOutVariance } from "./modelValidation.js";
import {
  CANONICAL_UNIT,
  MixedCurrencyError,
  detectDenominationFromText,
  normalizeCurrencyCode,
  normalizeCurrencyUnit,
  toCanonical,
  type CurrencyUnit,
} from "./denomination.js";

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
  /** Store unit after denomination reconciliation (always Million when rescaled). */
  canonical_unit?: string;
  fx_assumption?: string;
  business_model: string;
  revenue_streams: string[];
  financial_metrics: FinancialMetric[];
  header_mapping_suggestions?: HeaderMappingSuggestion[];
  competitive_landscape: string;
  key_risks: string[];
  benchmarks: Record<string, string>;
  /** Surfaced on GET /context — assumed zeros, tie-outs, tax rewrite notices. */
  model_warnings?: string[];
  tie_out_variances?: TieOutVariance[];
  tie_out_status?: "ok" | "variances";
  /** When tie-out finds material variances, context is not silently usable. */
  usability?: "usable" | "needs_review";
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
 * Build company context from all uploaded documents in a workspace.
 * Retrieves representative chunks, sends to Claude for extraction,
 * and stores the structured result.
 */
export async function buildContext(scope: Scope): Promise<CompanyContext> {
  const userId = await resolveUserId(scope.userId);
  const { workspaceId } = scope;

  // 1. Get all ready documents in this workspace
  const docResult = await pool.query(
    "SELECT document_id, name, file_type, created_at FROM documents WHERE workspace_id = $1 AND status = 'ready' ORDER BY created_at",
    [workspaceId]
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
   CONVENTION: operating_expenses EXCLUDES depreciation & amortization. EBITDA = gross_profit − operating_expenses; EBIT = EBITDA − depreciation_amortization.
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

  // 4. Store in company_context (upsert — one active context per workspace)
  // Deactivate any existing context
  await pool.query("UPDATE company_context SET status = 'superseded' WHERE workspace_id = $1 AND status = 'active'", [workspaceId]);

  const ctxResult = await pool.query(
    `INSERT INTO company_context (created_by, workspace_id, company_name, industry, context_data, source_document_ids, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'active')
     RETURNING *`,
    [userId, workspaceId, contextData.company_name, contextData.industry, JSON.stringify(contextData), docIds]
  );
  const ctx = ctxResult.rows[0];

  // 5. Generate and store a dynamic model definition
  const modelDef = buildModelFromContext(contextData);

  // Cross-foot extracted P&L against repaired formulas — gate usability on variances
  const tieOuts = crossFootExtractedPL(contextData.financial_metrics);
  const buildWarnings = [...(modelDef.build_warnings ?? [])];
  for (const v of tieOuts) buildWarnings.push(v.message);
  modelDef.build_warnings = buildWarnings.length > 0 ? buildWarnings : undefined;

  const gate = applyTieOutGate(tieOuts);
  contextData.model_warnings = modelDef.build_warnings;
  contextData.tie_out_variances = tieOuts.length > 0 ? tieOuts : undefined;
  contextData.tie_out_status = gate.tie_out_status;
  contextData.usability = gate.usability;

  await pool.query(
    "UPDATE company_context SET context_data = $1, updated_at = NOW() WHERE context_id = $2",
    [JSON.stringify(contextData), ctx.context_id],
  );

  // Deactivate existing models
  await pool.query("UPDATE user_models SET is_active = false WHERE workspace_id = $1 AND is_active = true", [workspaceId]);

  // Only activate an executable model when tie-out gate passes; needs_review stays inactive.
  const activate = gate.usability === "usable";
  await pool.query(
    `INSERT INTO user_models (created_by, workspace_id, name, model_definition, source_context_id, is_active)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      userId,
      workspaceId,
      `${contextData.company_name || "Company"} P&L Model`,
      JSON.stringify({
        ...modelDef,
        usability: gate.usability,
        tie_out_status: gate.tie_out_status,
      }),
      ctx.context_id,
      activate,
    ],
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

/**
 * Canonical P&L identities for formula repair.
 *
 * Convention: operating_expenses EXCLUDES depreciation & amortization.
 *   EBITDA = gross_profit − operating_expenses
 *   EBIT   = EBITDA − depreciation_amortization
 *   PBT    = EBIT − finance_costs + other_income
 *   NI     = PBT − tax_expense
 *
 * When D&A is absent, degraded fallbacks treat EBIT ≈ EBITDA and emit a build warning.
 */
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
    { deps: ["ebitda", "depreciation_amortization"], formula: "ebitda - depreciation_amortization" },
    { deps: ["ebit"], formula: "ebit" },
    { deps: ["gross_profit", "operating_expenses", "depreciation_amortization"], formula: "gross_profit - operating_expenses - depreciation_amortization" },
    { deps: ["gross_profit", "operating_expenses"], formula: "gross_profit - operating_expenses" },
    { deps: ["gross_profit", "opex"], formula: "gross_profit - opex" },
  ],
  // Preferred: EBIT = EBITDA − D&A. Do NOT use gross_profit − opex (that is EBITDA).
  ebit: [
    { deps: ["ebitda", "depreciation_amortization"], formula: "ebitda - depreciation_amortization" },
    { deps: ["ebitda", "depreciation"], formula: "ebitda - depreciation" },
    { deps: ["gross_profit", "operating_expenses", "depreciation_amortization"], formula: "gross_profit - operating_expenses - depreciation_amortization" },
    { deps: ["operating_income"], formula: "operating_income" },
    // Degraded fallback when D&A missing — EBIT treated equal to EBITDA
    { deps: ["ebitda"], formula: "ebitda" },
    { deps: ["gross_profit", "operating_expenses"], formula: "gross_profit - operating_expenses" },
  ],
  // Preferred: EBITDA = GP − opex (opex excludes D&A).
  ebitda: [
    { deps: ["gross_profit", "operating_expenses"], formula: "gross_profit - operating_expenses" },
    { deps: ["gross_profit", "opex"], formula: "gross_profit - opex" },
    { deps: ["revenue", "cogs", "operating_expenses"], formula: "revenue - cogs - operating_expenses" },
    { deps: ["revenue", "cost_of_revenue", "operating_expenses"], formula: "revenue - cost_of_revenue - operating_expenses" },
    { deps: ["ebit", "depreciation_amortization"], formula: "ebit + depreciation_amortization" },
    { deps: ["operating_income", "depreciation_amortization"], formula: "operating_income + depreciation_amortization" },
    { deps: ["operating_income", "depreciation", "amortization"], formula: "operating_income + depreciation + amortization" },
    { deps: ["revenue", "total_expenses"], formula: "revenue - total_expenses" },
  ],
  profit_before_tax: [
    { deps: ["ebit", "finance_costs", "other_income"], formula: "ebit - finance_costs + other_income" },
    { deps: ["ebit", "interest_expense", "other_income"], formula: "ebit - interest_expense + other_income" },
    { deps: ["ebit", "finance_costs"], formula: "ebit - finance_costs" },
    { deps: ["ebit", "interest_expense"], formula: "ebit - interest_expense" },
    { deps: ["operating_income", "interest_expense", "other_income"], formula: "operating_income - interest_expense + other_income" },
    { deps: ["operating_income", "interest_expense"], formula: "operating_income - interest_expense" },
    { deps: ["ebitda", "depreciation_amortization", "interest_expense"], formula: "ebitda - depreciation_amortization - interest_expense" },
    { deps: ["operating_income"], formula: "operating_income" },
    { deps: ["ebit"], formula: "ebit" },
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

/** Select first matching known formula (no DEMO_MODE gate — for tests / callers). */
export function selectKnownFormula(
  variableId: string,
  availableVars: Set<string>,
): { formula: string; deps: string[] } | null {
  const candidates = KNOWN_CALCULATED_FORMULAS[variableId];
  if (!candidates) return null;
  for (const c of candidates) {
    if (c.deps.every((d) => availableVars.has(d))) {
      return { formula: c.formula, deps: [...c.deps] };
    }
  }
  return null;
}

function findKnownFormula(
  variableId: string,
  availableVars: Set<string>,
): { formula: string; deps: string[] } | null {
  // Production-safe: known P&L identities may be proposed as candidates.
  // Acceptance is gated by tryIdentityRepair() which requires cross-foot tie-out.
  // DEMO_MODE still enables seed mappings elsewhere; identity candidates are always available.
  return selectKnownFormula(variableId, availableVars);
}

/**
 * Accept a known-identity formula only when it reproduces the metric's
 * stated typical_value within tolerance (cross-foot tie-out).
 */
function tryIdentityRepair(
  metric: FinancialMetric,
  metrics: FinancialMetric[],
  availableVars: Set<string>,
): { formula: string; deps: string[]; provenance: "identity_repair" } | null {
  const candidate = findKnownFormula(metric.variable_id, availableVars);
  if (!candidate) return null;

  const byId = new Map(metrics.map((m) => [m.variable_id, m]));
  const ctx: Record<string, number> = {};
  for (const d of candidate.deps) {
    const dep = byId.get(d);
    if (!dep || dep.typical_value == null || !Number.isFinite(dep.typical_value)) {
      // Cannot verify — only accept in DEMO_MODE without tie-out
      if (config.DEMO_MODE) {
        return { ...candidate, provenance: "identity_repair" };
      }
      return null;
    }
    ctx[d] = dep.typical_value;
  }

  // If metric has no stated value, accept candidate only in DEMO_MODE
  if (metric.typical_value == null || !Number.isFinite(metric.typical_value)) {
    if (config.DEMO_MODE) return { ...candidate, provenance: "identity_repair" };
    return null;
  }

  try {
    const knownIds = new Set(metrics.map((m) => m.variable_id));
    const fn = compileFormula(candidate.formula, knownIds, metric.variable_id);
    const computed = fn(ctx, {
      min: Math.min,
      max: Math.max,
      abs: Math.abs,
      round: Math.round,
      floor: Math.floor,
      ceil: Math.ceil,
      sqrt: Math.sqrt,
      pow: Math.pow,
    });
    if (!Number.isFinite(computed)) return null;
    const extracted = metric.typical_value;
    const denom = Math.abs(extracted) > 1e-9 ? Math.abs(extracted) : Math.abs(computed);
    if (denom < 1e-9) return null;
    const tolerance = (config.IDENTITY_REPAIR_TOLERANCE ?? 0.01) * 100; // percent
    const variancePct = (Math.abs(extracted - computed) / denom) * 100;
    if (variancePct > tolerance) {
      logger.info(
        `[ContextEngine] Rejected identity repair for ${metric.variable_id}: variance ${variancePct.toFixed(2)}% > ${tolerance}%`,
      );
      return null;
    }
    return { ...candidate, provenance: "identity_repair" };
  } catch (e) {
    logger.warn(
      `[ContextEngine] Identity repair compile failed for ${metric.variable_id}: ${(e as Error).message}`,
    );
    return null;
  }
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
        tryIdentityRepair(m, metrics, varIds) ||
        buildFormulaFromDependencies(m.dependencies, m.category, varIds);
      if (repaired) {
        m.formula = repaired.formula;
        m.dependencies = repaired.deps;
        if ("provenance" in repaired && typeof (repaired as { provenance?: unknown }).provenance === "string") {
          (m as FinancialMetric & { provenance?: string }).provenance =
            (repaired as { provenance: string }).provenance;
        }
        logger.info(`[ContextEngine] Repaired formula for ${m.variable_id}: ${m.formula}`);
      }
    }

    // Pass 2: marked as input but should be calculated — always try for TYPICALLY_CALCULATED vars
    if (m.is_input && TYPICALLY_CALCULATED.has(m.variable_id)) {
      const repaired = tryIdentityRepair(m, metrics, varIds);
      if (repaired) {
        m.is_input = false;
        m.formula = repaired.formula;
        m.dependencies = repaired.deps;
        (m as FinancialMetric & { provenance?: string }).provenance = repaired.provenance;
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
          tryIdentityRepair(m, metrics, varIds) ||
          buildFormulaFromDependencies(m.dependencies, m.category, varIds);
        if (repaired) {
          m.formula = repaired.formula;
          m.dependencies = repaired.deps;
          if ("provenance" in repaired && typeof (repaired as { provenance?: unknown }).provenance === "string") {
            (m as FinancialMetric & { provenance?: string }).provenance =
              (repaired as { provenance: string }).provenance;
          }
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
  variables: BuildVar[],
  warnings: string[],
): void {
  const varIds = new Set(variables.map((v) => v.id));
  const hasDA = varIds.has("depreciation_amortization") || varIds.has("depreciation");

  for (const v of variables) {
    if (!v.tags.includes("output")) continue;
    if (!isNumericFormula(v.formula)) continue;

    const repaired = tryIdentityRepair(
      {
        name: v.name,
        variable_id: v.id,
        description: "",
        typical_value: typeof v.formula === "string" && /^-?\d/.test(v.formula) ? Number(v.formula) : undefined,
        unit: "",
        category: "other",
        is_input: false,
        formula: v.formula,
        dependencies: v.dependencies,
      },
      variables.map((x) => ({
        name: x.name,
        variable_id: x.id,
        description: "",
        typical_value: undefined,
        unit: "",
        category: "other" as const,
        is_input: x.dependencies.length === 0,
        formula: x.formula,
        dependencies: x.dependencies,
      })),
      varIds,
    );
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

  if (!hasDA && (varIds.has("ebit") || varIds.has("ebitda"))) {
    warnings.push("D&A not extracted — EBIT and EBITDA treated as equal");
  }
}

type BuildVar = ModelVariable & { tags: string[] };

const SAFE_FN_NAMES = new Set(["min", "max", "abs", "round", "floor", "ceil", "sqrt", "pow"]);

function metricTypeForBuild(m: FinancialMetric): MetricType {
  return m.metric_type ?? inferMetricTypeFromId(m.variable_id, m.name);
}

function dependentsOf(variables: BuildVar[], targetId: string): string[] {
  return variables.filter((v) => v.dependencies.includes(targetId)).map((v) => v.id);
}

/**
 * Rewrite fixed tax_expense as effective_tax_rate × max(0, PBT).
 * Build-time only — existing stored models unchanged.
 */
export function rewriteTaxAsEffectiveRate(variables: BuildVar[], warnings: string[]): void {
  const TAX_IDS = ["tax_expense", "tax", "income_tax"];
  const PBT_IDS = ["profit_before_tax", "pbt"];

  const taxVar = variables.find((v) => TAX_IDS.includes(v.id) && v.dependencies.length === 0);
  if (!taxVar) return;

  const pbtVar = variables.find((v) => PBT_IDS.includes(v.id));
  if (!pbtVar) {
    warnings.push("Tax rewrite skipped — profit_before_tax not found in model");
    return;
  }

  // Resolve base values from numeric formulas / evaluate
  let taxBase: number;
  let pbtBase: number;
  try {
    const tmp: ModelDefinition = {
      model_version: "tax-rewrite-probe",
      time_horizon: { start: "2026-Q1", end: "2026-Q1", granularity: "quarterly" },
      variables: variables.map((v) => ({ ...v })),
    };
    const base = new CompiledModel(tmp).baseValues();
    taxBase = base[taxVar.id] ?? 0;
    pbtBase = base[pbtVar.id] ?? 0;
  } catch {
    warnings.push("Tax rewrite skipped — model failed to compile during rate derivation");
    return;
  }

  if (pbtBase <= 0) {
    warnings.push(`Tax rewrite skipped — PBT is ${pbtBase} (need positive PBT to derive effective rate)`);
    return;
  }
  if (taxBase < 0) {
    warnings.push("Tax rewrite skipped — tax_expense is negative");
    return;
  }
  const rate = taxBase / pbtBase;
  if (!(rate > 0 && rate <= 0.6)) {
    warnings.push(`Tax rewrite skipped — implied rate ${(rate * 100).toFixed(1)}% outside (0%, 60%]`);
    return;
  }

  // Cycle safety: skip if PBT transitively depends on tax
  const byId = new Map(variables.map((v) => [v.id, v]));
  const visiting = new Set<string>();
  function dependsOnTax(id: string): boolean {
    if (id === taxVar!.id) return true;
    if (visiting.has(id)) return false;
    visiting.add(id);
    const v = byId.get(id);
    if (!v) return false;
    return v.dependencies.some((d) => dependsOnTax(d));
  }
  if (dependsOnTax(pbtVar.id)) {
    warnings.push("Tax rewrite skipped — profit_before_tax depends on tax (cycle)");
    return;
  }

  const ratePct = Math.round(rate * 10000) / 100;
  const snapshot = {
    formula: taxVar.formula,
    dependencies: [...taxVar.dependencies],
    tags: [...taxVar.tags],
    provenance: taxVar.provenance,
    metric_type: taxVar.metric_type,
  };

  if (!variables.some((v) => v.id === "effective_tax_rate")) {
    variables.push({
      id: "effective_tax_rate",
      name: "Effective Tax Rate",
      formula: String(ratePct),
      dependencies: [],
      tags: ["input", "percent_delta"],
      metric_type: "percent",
      provenance: "derived",
    });
  }

  taxVar.formula = `max(0, ${pbtVar.id}) * effective_tax_rate / 100`;
  taxVar.dependencies = [pbtVar.id, "effective_tax_rate"];
  taxVar.tags = ["pl_metric", "output"];
  taxVar.provenance = "derived";
  taxVar.metric_type = "currency";

  try {
    const check: ModelDefinition = {
      model_version: "tax-rewrite-check",
      time_horizon: { start: "2026-Q1", end: "2026-Q1", granularity: "quarterly" },
      variables: variables.map((v) => ({ ...v })),
    };
    new CompiledModel(check);
  } catch (e) {
    taxVar.formula = snapshot.formula;
    taxVar.dependencies = snapshot.dependencies;
    taxVar.tags = snapshot.tags;
    taxVar.provenance = snapshot.provenance;
    taxVar.metric_type = snapshot.metric_type;
    const idx = variables.findIndex((v) => v.id === "effective_tax_rate" && v.provenance === "derived");
    if (idx >= 0) variables.splice(idx, 1);
    warnings.push(`Tax rewrite reverted — compile failed: ${(e as Error).message}`);
    return;
  }

  warnings.push(
    `Tax rewritten as effective rate ${ratePct}% × max(0, ${pbtVar.id}). ` +
      `Override effective_tax_rate to change the rate; tax now scales with PBT.`,
  );
}

/**
 * Build a ModelDefinition from extracted financial metrics.
 * Exported for unit tests (no Postgres required).
 */
export function buildModelFromContext(ctx: ContextData): ModelDefinition {
  validateAndRepairMetrics(ctx.financial_metrics);
  const warnings: string[] = [];

  const variables: BuildVar[] = ctx.financial_metrics.map((m) => ({
    id: m.variable_id,
    name: m.name,
    formula: m.is_input
      ? String(m.typical_value ?? 0)
      : (m.formula || "0"),
    dependencies: m.dependencies || [],
    tags: buildTags(m),
    metric_type: metricTypeForBuild(m),
    provenance: "extracted" as VariableProvenance,
  }));

  // Inject missing dependency variables referenced in formulas but not present in the model.
  const varIds = new Set(variables.map((v) => v.id));
  const missingVars = new Set<string>();
  for (const v of variables) {
    for (const dep of v.dependencies) {
      if (!varIds.has(dep)) missingVars.add(dep);
    }
    const formulaRefs = v.formula.match(/\b[a-z][a-z0-9_]*\b/g) || [];
    for (const ref of formulaRefs) {
      if (SAFE_FN_NAMES.has(ref)) continue;
      if (!varIds.has(ref) && !missingVars.has(ref)) {
        missingVars.add(ref);
      }
    }
  }

  for (const missing of missingVars) {
    const matchingMetric = ctx.financial_metrics.find((m) =>
      m.variable_id === missing || m.name.toLowerCase().replace(/[^a-z0-9]/g, "_").includes(missing)
    );
    const value = matchingMetric?.typical_value ?? 0;
    const name = missing.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    const provenance: VariableProvenance = matchingMetric?.typical_value != null ? "extracted" : "assumed";
    variables.push({
      id: missing,
      name,
      formula: String(value),
      dependencies: [],
      tags: ["pl_metric", "input", "percent_delta"],
      metric_type: inferMetricTypeFromId(missing, name),
      provenance,
    });
    varIds.add(missing);
    if (provenance === "assumed") {
      const deps = dependentsOf(variables, missing);
      warnings.push(
        `'${name}' referenced by formulas but not found in document — assumed 0. ` +
          `Review dependent metrics (${deps.length ? deps.join(", ") : "none yet"}).`,
      );
    }
    logger.info(`[ContextEngine] Injected missing dependency variable: ${missing} = ${value} (${provenance})`);
  }

  // Also ensure dependencies arrays are complete — add any formula-referenced vars to deps
  for (const v of variables) {
    const formulaRefs = v.formula.match(/\b[a-z][a-z0-9_]*\b/g) || [];
    for (const ref of formulaRefs) {
      if (SAFE_FN_NAMES.has(ref)) continue;
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
      const similar = variables.find((v) => v.id.includes(e.id) || v.name.toLowerCase().includes(e.id));
      if (!similar) {
        variables.push({
          id: e.id,
          name: e.name,
          formula: "0",
          dependencies: [],
          tags: [e.needsTag, "input", "percent_delta"],
          metric_type: "currency",
          provenance: "assumed",
        });
        varIds.add(e.id);
        warnings.push(
          `Model is incomplete — essential '${e.id}' was not extracted and was assumed 0. ` +
            `Upload a fuller P&L or edit the model before relying on simulations.`,
        );
      }
    }
  }

  rewriteTaxAsEffectiveRate(variables, warnings);
  sanityCheckVariables(variables, warnings);

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
    ...(warnings.length > 0 ? { build_warnings: warnings } : {}),
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

  // Rescale currency metric values into the canonical store unit (Million).
  const sourceUnit = ctx.currency_unit as CurrencyUnit;
  const sourceCurrency = ctx.currency;
  const warnings: string[] = [...(ctx.model_warnings ?? [])];
  for (const m of ctx.financial_metrics) {
    if (m.typical_value == null || !Number.isFinite(m.typical_value)) continue;
    const metricType = m.metric_type || inferMetricType(m);
    if (metricType !== "currency" && metricType !== "unknown") continue;
    // Percent / count / ratio / volume must not be rescaled.
    if (metricType === "unknown") {
      const text = `${m.name} ${m.unit} ${m.variable_id}`.toLowerCase();
      if (/%|percent|ratio|count|headcount|volume|units/.test(text)) continue;
    }
    try {
      const scaled = toCanonical(m.typical_value, {
        unit: sourceUnit,
        currency: sourceCurrency,
      });
      m.typical_value = scaled.value;
      if (scaled.source_unit && scaled.source_unit !== CANONICAL_UNIT) {
        m.unit = `${sourceCurrency} ${CANONICAL_UNIT}`;
      }
    } catch (e) {
      if (e instanceof MixedCurrencyError) {
        warnings.push(e.message);
      }
    }
  }
  ctx.canonical_unit = CANONICAL_UNIT;
  if (warnings.length > 0) ctx.model_warnings = warnings;
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

function detectDenominationHints(text: string): DenominationHints {
  const detected = detectDenominationFromText(text);
  return {
    currency: detected.currency,
    currency_unit: detected.unit,
    evidence: detected.evidence,
  };
}

// ── Context Retrieval ──

export async function getActiveContext(scope: Scope): Promise<CompanyContext | null> {
  const r = await pool.query(
    "SELECT * FROM company_context WHERE workspace_id = $1 AND status = 'active' ORDER BY created_at DESC LIMIT 1",
    [scope.workspaceId]
  );
  if (r.rows.length === 0) return null;
  return r.rows[0];
}

export async function getActiveModel(scope: Scope): Promise<{ model_id: string; name: string; model_definition: ModelDefinition; is_active: boolean } | null> {
  const r = await pool.query(
    "SELECT * FROM user_models WHERE workspace_id = $1 AND is_active = true ORDER BY created_at DESC LIMIT 1",
    [scope.workspaceId]
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

export async function deleteContext(scope: Scope): Promise<void> {
  await pool.query("UPDATE company_context SET status = 'deleted' WHERE workspace_id = $1 AND status = 'active'", [scope.workspaceId]);
  await pool.query("UPDATE user_models SET is_active = false WHERE workspace_id = $1 AND is_active = true", [scope.workspaceId]);
}

/**
 * Build a text description of the company context for injection into LLM prompts.
 */
/** Summarize revenue vs cost makeup for agent / analysis prompts. */
export function describeCostRevenueComposition(d: ContextData): string | null {
  const metrics = d.financial_metrics || [];
  if (metrics.length === 0 && !(d.revenue_streams?.length)) return null;

  const lines: string[] = ["COST-REVENUE COMPOSITION:"];
  if (d.revenue_streams?.length) {
    lines.push(`Revenue streams: ${d.revenue_streams.join(", ")}`);
  }

  const fmt = (m: FinancialMetric) =>
    `${m.name || m.variable_id}${m.typical_value != null ? ` (${m.typical_value}${m.unit ? ` ${m.unit}` : ""})` : ""}${m.is_input ? " [input]" : " [calc]"}`;

  const revenue = metrics.filter((m) => m.category === "revenue" || m.category === "income");
  const costs = metrics.filter((m) => m.category === "cost" || m.category === "expense");
  const margins = metrics.filter((m) => m.category === "margin");

  if (revenue.length) lines.push(`Revenue line items: ${revenue.map(fmt).join("; ")}`);
  if (costs.length) lines.push(`Cost / expense line items: ${costs.map(fmt).join("; ")}`);
  if (margins.length) lines.push(`Margin metrics: ${margins.map(fmt).join("; ")}`);

  const revTotal = revenue
    .filter((m) => m.is_input && typeof m.typical_value === "number")
    .reduce((s, m) => s + (m.typical_value || 0), 0);
  const costTotal = costs
    .filter((m) => m.is_input && typeof m.typical_value === "number")
    .reduce((s, m) => s + (m.typical_value || 0), 0);
  if (revTotal > 0 && costTotal > 0) {
    lines.push(
      `Input-lever totals (approx): revenue ${revTotal.toLocaleString()}, costs ${costTotal.toLocaleString()}, cost/revenue ${(
        (costTotal / revTotal) *
        100
      ).toFixed(1)}%`,
    );
  }

  return lines.length > 1 ? lines.join("\n") : null;
}

export async function describeContextForLLM(scope: Scope): Promise<string | null> {
  const ctx = await getActiveContext(scope);
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
  const composition = describeCostRevenueComposition(d);
  if (composition) {
    lines.push(composition);
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
