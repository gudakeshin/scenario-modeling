/**
 * Scenario Reasoning Agent — open-ended / macro NL → structured parameters
 * via a multi-tool Claude loop (schema, context, docs, web, what-if preview).
 */

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { config } from "../config.js";
import { pool } from "../db/index.js";
import type { Scope } from "../middleware/workspace.js";
import { callClaudeAgentLoop, type AgentTool } from "./llmClient.js";
import { searchPerplexity } from "./searchService.js";
import { searchDocumentChunksInDb } from "./documentService.js";
import { previewSimulationForScenario } from "./simulationService.js";
import {
  describeContextForLLM as describeScenarioContext,
  getScenarioContext,
  hydrateScenarioContext,
  validateAgainstConstraints,
  type ScenarioConstraint,
} from "./scenarioContextService.js";
import { describeContextForLLM as describeCompanyContext } from "./contextEngine.js";
import { getInputVariables, type ModelDefinition } from "../models/registry.js";
import { logger } from "../logger.js";

export interface AgentParameterProvenance {
  citation_index?: number;
  source?: string;
  snippet?: string;
  url?: string;
  rationale?: string;
}

export interface AgentParsedParameter {
  name: string;
  variable_type: string;
  direction: string;
  magnitude: number;
  unit: string;
  scope: Record<string, string>;
  member_scope?: Record<string, string>;
  confidence: number;
  suggested_variable_id?: string;
  provenance?: AgentParameterProvenance;
}

export interface PreviewReconciliation {
  reconciled: boolean;
  max_abs_diff: number;
  diffs: Record<string, { preview: number; final: number; abs_diff: number }>;
  message?: string;
}

const proposeParametersSchema = z.object({
  parameters: z
    .array(
      z.object({
        name: z.string(),
        variable_type: z.string().default("operational_change"),
        direction: z.string().default("set"),
        magnitude: z.number().default(0),
        unit: z.string().default("percent"),
        scope: z.record(z.string()).default({}),
        member_scope: z.record(z.string()).optional(),
        confidence: z.number().min(0).max(1).default(0.5),
        suggested_variable_id: z.string().optional(),
        /** Magnitude↔citation provenance — which research backs this lever. */
        provenance: z
          .object({
            citation_index: z.number().int().nonnegative().optional(),
            source: z.string().optional(),
            snippet: z.string().optional(),
            url: z.string().optional(),
            rationale: z.string().optional(),
          })
          .optional(),
      }),
    )
    .default([]),
  causal_chain: z
    .array(
      z.object({
        step: z.string(),
        detail: z.string().optional(),
        kind: z
          .enum(["decomposition", "research", "levers", "preview", "other"])
          .default("other"),
      }),
    )
    .default([]),
  citations: z
    .array(
      z.object({
        source: z.string(),
        snippet: z.string().optional(),
        url: z.string().optional(),
      }),
    )
    .default([]),
  confidence: z.number().min(0).max(1).default(0.5),
  clarification_needed: z.string().nullable().optional(),
});

export type ProposeParametersResult = z.infer<typeof proposeParametersSchema>;

export interface AgentTraceStep {
  tool: string;
  input: unknown;
  output: unknown;
}

export interface AgentConstraintViolation {
  lever: string;
  reason: string;
}

/** Structured readiness diagnostics for showcase agent gating. */
export interface AgentReadiness {
  enabled: boolean;
  model_validated: boolean;
  ready: boolean;
  reasons: string[];
  showcase_agent_enabled: boolean;
  has_validated_model: boolean;
  has_active_user_model: boolean;
  validated_document_kind?: string | null;
}

export interface ScenarioReasoningResult {
  parameters: AgentParsedParameter[];
  causal_chain: ProposeParametersResult["causal_chain"];
  citations: ProposeParametersResult["citations"];
  confidence: number;
  clarification_needed?: string;
  agent_trace: AgentTraceStep[];
  stopped_reason: string;
  error?: string;
  preview_pl?: Record<string, number>;
  final_preview_pl?: Record<string, number>;
  preview_reconciliation?: PreviewReconciliation;
  constraint_violations?: AgentConstraintViolation[];
  readiness?: AgentReadiness;
  rejected_non_input_levers?: string[];
}

function toolSchema(name: string, schema: z.ZodTypeAny) {
  const json = zodToJsonSchema(schema, name);
  return (json.definitions?.[name] ?? json) as AgentTool["inputSchema"];
}

async function probeModelState(workspaceId: string): Promise<{
  hasValidatedModel: boolean;
  hasActiveUserModel: boolean;
  validatedDocumentKind: string | null;
}> {
  const doc = await pool.query(
    `SELECT document_kind FROM documents
     WHERE workspace_id = $1
       AND status = 'ready'
       AND validation_status = 'ready'
       AND document_kind IN ('spreadsheet_model', 'tabular_data')
     ORDER BY created_at DESC
     LIMIT 1`,
    [workspaceId],
  );
  const um = await pool.query(
    `SELECT 1 FROM user_models WHERE workspace_id = $1 AND is_active = true LIMIT 1`,
    [workspaceId],
  );
  return {
    hasValidatedModel: doc.rows.length > 0,
    hasActiveUserModel: um.rows.length > 0,
    validatedDocumentKind: (doc.rows[0]?.document_kind as string) || null,
  };
}

/**
 * Diagnose whether the showcase reasoning agent can run for this workspace.
 */
export async function getAgentReadiness(workspaceId: string): Promise<AgentReadiness> {
  const profileEnables =
    config.DEPLOYMENT_PROFILE === "showcase" || config.DEPLOYMENT_PROFILE === "enterprise";
  const enabled = !!config.SHOWCASE_AGENT_ENABLED || profileEnables;
  const state = await probeModelState(workspaceId);
  const model_validated = state.hasValidatedModel || state.hasActiveUserModel;
  const reasons: string[] = [];
  if (!enabled) {
    reasons.push(
      "Agent disabled — set SHOWCASE_AGENT_ENABLED=true or DEPLOYMENT_PROFILE=showcase|enterprise.",
    );
  }
  if (!model_validated) {
    reasons.push(
      "No validated executable model — upload a workbook/CSV, complete validation (validation_status=ready), or activate a user model.",
    );
  }
  return {
    enabled,
    model_validated,
    ready: enabled && model_validated,
    reasons,
    showcase_agent_enabled: enabled,
    has_validated_model: state.hasValidatedModel,
    has_active_user_model: state.hasActiveUserModel,
    validated_document_kind: state.validatedDocumentKind,
  };
}

async function hasValidatedModel(workspaceId: string): Promise<boolean> {
  const r = await getAgentReadiness(workspaceId);
  return r.model_validated;
}

/**
 * Collect allowed INPUT lever ids for the workspace (never calculated outputs).
 */
export async function getWorkspaceInputLeverIds(workspaceId: string): Promise<Set<string>> {
  const ids = new Set<string>();

  const doc = await pool.query(
    `SELECT model_schema FROM documents
     WHERE workspace_id = $1 AND model_schema IS NOT NULL
     ORDER BY CASE WHEN validation_status = 'ready' THEN 0 ELSE 1 END, created_at DESC
     LIMIT 1`,
    [workspaceId],
  );
  const schema = doc.rows[0]?.model_schema as
    | { scenarioLevers?: Array<{ id?: string }>; outputMetrics?: Array<{ id?: string }> }
    | null;
  if (schema?.scenarioLevers?.length) {
    for (const lever of schema.scenarioLevers) {
      if (lever?.id) ids.add(lever.id);
    }
  }

  const um = await pool.query(
    `SELECT model_definition FROM user_models
     WHERE workspace_id = $1 AND is_active = true
     ORDER BY created_at DESC LIMIT 1`,
    [workspaceId],
  );
  if (um.rows[0]?.model_definition) {
    const def = um.rows[0].model_definition as ModelDefinition;
    if (Array.isArray(def.variables)) {
      for (const v of getInputVariables(def)) ids.add(v.id);
      for (const v of def.variables) {
        if (v.tags?.includes("input") && !v.tags?.includes("output")) ids.add(v.id);
      }
    }
  }

  return ids;
}

/**
 * Keep only parameters that map to known INPUT levers; drop calculated outputs.
 * Pure helper for unit tests.
 */
export function filterParametersToInputLevers<
  T extends { suggested_variable_id?: string; name?: string },
>(parameters: T[], inputIds: Set<string>): { kept: T[]; rejected: string[] } {
  if (inputIds.size === 0) {
    // No catalog available — keep params without a suggested id; drop nothing aggressively
    return { kept: parameters, rejected: [] };
  }
  const kept: T[] = [];
  const rejected: string[] = [];
  for (const p of parameters) {
    const id = p.suggested_variable_id;
    if (!id) {
      // Unmapped — keep for human review / mapping service
      kept.push(p);
      continue;
    }
    if (inputIds.has(id)) {
      kept.push(p);
    } else {
      rejected.push(id);
    }
  }
  return { kept, rejected };
}

async function getModelSchemaPayload(workspaceId: string): Promise<unknown> {
  const doc = await pool.query(
    `SELECT model_schema, name FROM documents
     WHERE workspace_id = $1 AND model_schema IS NOT NULL
     ORDER BY CASE WHEN validation_status = 'ready' THEN 0 ELSE 1 END, created_at DESC
     LIMIT 1`,
    [workspaceId],
  );
  if (doc.rows[0]?.model_schema) {
    return { source: "documents.model_schema", name: doc.rows[0].name, schema: doc.rows[0].model_schema };
  }
  const um = await pool.query(
    `SELECT name, model_definition FROM user_models
     WHERE workspace_id = $1 AND is_active = true
     ORDER BY created_at DESC LIMIT 1`,
    [workspaceId],
  );
  if (um.rows[0]) {
    return {
      source: "user_models",
      name: um.rows[0].name,
      schema: um.rows[0].model_definition,
    };
  }
  return { error: "No model schema found for workspace" };
}

function buildTools(opts: {
  scope: Scope;
  scenarioId?: string;
  constraints: ScenarioConstraint[];
  inputLeverIds: Set<string>;
}): AgentTool[] {
  const { scope, scenarioId, constraints, inputLeverIds } = opts;

  const getModelSchemaTool: AgentTool = {
    name: "get_model_schema",
    description: "Load the workspace financial model schema (levers, outputs, formulas).",
    inputSchema: toolSchema(
      "get_model_schema",
      z.object({ workspaceId: z.string().optional() }),
    ),
    handler: async (input) => {
      const wid =
        (input as { workspaceId?: string })?.workspaceId || scope.workspaceId;
      const payload = await getModelSchemaPayload(wid);
      return {
        ...(typeof payload === "object" && payload ? payload : { payload }),
        allowed_input_lever_ids: [...inputLeverIds],
      };
    },
  };

  const getBusinessContextTool: AgentTool = {
    name: "get_business_context",
    description:
      "Load company/industry/business-model and cost-revenue composition context for the workspace.",
    inputSchema: toolSchema(
      "get_business_context",
      z.object({ scope: z.string().optional() }),
    ),
    handler: async () => {
      const company = await describeCompanyContext(scope);
      let scenarioCtx = "";
      if (scenarioId) {
        await hydrateScenarioContext(scenarioId);
        scenarioCtx = describeScenarioContext(getScenarioContext(scenarioId));
      }
      return { company_context: company, scenario_context: scenarioCtx || undefined };
    },
  };

  const searchDocumentsTool: AgentTool = {
    name: "search_documents",
    description: "Search uploaded workspace documents for relevant passages.",
    inputSchema: toolSchema("search_documents", z.object({ query: z.string() })),
    handler: async (input) => {
      const query = String((input as { query?: string })?.query || "").trim();
      if (!query) return { results: [] };
      const results = await searchDocumentChunksInDb(query, scope.workspaceId, 6);
      return {
        results: results.map((r) => ({
          document_name: r.document_name,
          chunk_index: r.chunk_index,
          score: r.score,
          text: r.text.slice(0, 800),
        })),
      };
    },
  };

  const webResearchTool: AgentTool = {
    name: "web_research",
    description: "Search the web (Perplexity) for macro/market quantitative context.",
    inputSchema: toolSchema("web_research", z.object({ query: z.string() })),
    handler: async (input) => {
      const query = String((input as { query?: string })?.query || "").trim();
      if (!query) return { error: "query required" };
      const result = await searchPerplexity(query);
      return result ?? { error: "Web research unavailable (PERPLEXITY_API_KEY missing or failed)" };
    },
  };

  const runWhatIfTool: AgentTool = {
    name: "run_what_if",
    description:
      "Preview a simulation with proposed lever overrides (does not persist). Validates constraints. Only INPUT levers allowed.",
    inputSchema: toolSchema(
      "run_what_if",
      z.object({
        parameters: z
          .array(
            z.object({
              variable_id: z.string(),
              value: z.number(),
              delta_type: z.enum(["percent", "absolute"]).default("percent"),
            }),
          )
          .min(1),
      }),
    ),
    handler: async (input) => {
      if (!scenarioId) {
        return { error: "Preview requires an existing scenario_id" };
      }
      const params = (input as {
        parameters?: Array<{ variable_id: string; value: number; delta_type?: string }>;
      })?.parameters;
      if (!params?.length) return { error: "parameters required" };

      if (inputLeverIds.size > 0) {
        const bad = params.filter((p) => !inputLeverIds.has(p.variable_id));
        if (bad.length) {
          return {
            blocked: true,
            error: `Non-input / unknown levers rejected: ${bad.map((b) => b.variable_id).join(", ")}. Use only: ${[...inputLeverIds].slice(0, 40).join(", ")}`,
            rejected: bad.map((b) => b.variable_id),
          };
        }
      }

      const absoluteProbe: Record<string, number> = {};
      for (const p of params) absoluteProbe[p.variable_id] = p.value;
      const validation = validateAgainstConstraints(absoluteProbe, constraints);
      if (!validation.ok) {
        return {
          blocked: true,
          violations: validation.violations,
          error: `Constraint violation: ${validation.violations.map((v) => v.reason).join("; ")}`,
        };
      }

      try {
        const preview = await previewSimulationForScenario(
          scenarioId,
          params.map((p) => ({
            variableId: p.variable_id,
            value: p.value,
            delta_type: (p.delta_type === "absolute" ? "absolute" : "percent") as
              | "percent"
              | "absolute",
          })),
        );
        return {
          pl: preview.pl,
          simulation_mode: preview.simulation_mode,
          absurdity_warnings: preview.absurdity_warnings,
        };
      } catch (e) {
        return { error: (e as Error).message };
      }
    },
  };

  const proposeParametersTool: AgentTool = {
    name: "propose_parameters",
    description:
      "TERMINAL: Submit final scenario parameters, causal chain, citations, and confidence. suggested_variable_id MUST be an INPUT lever id.",
    inputSchema: toolSchema("propose_parameters", proposeParametersSchema),
    handler: async (input) => input,
  };

  return [
    getModelSchemaTool,
    getBusinessContextTool,
    searchDocumentsTool,
    webResearchTool,
    runWhatIfTool,
    proposeParametersTool,
  ];
}

function emptyResult(
  partial: Partial<ScenarioReasoningResult> & { stopped_reason: string },
): ScenarioReasoningResult {
  return {
    parameters: [],
    causal_chain: [],
    citations: [],
    confidence: 0,
    agent_trace: [],
    ...partial,
  };
}

/**
 * Run the agentic scenario reasoner for open-ended NL input.
 */
export async function runScenarioReasoning(
  nlInput: string,
  scope: Scope,
  scenarioId?: string,
): Promise<ScenarioReasoningResult> {
  const readiness = await getAgentReadiness(scope.workspaceId);

  if (!readiness.enabled) {
    return emptyResult({
      stopped_reason: "disabled",
      readiness,
      error: readiness.reasons[0],
      clarification_needed:
        "Open-ended agentic analysis is not enabled. Use an explicit lever change (e.g. \"revenue +10%\") or set SHOWCASE_AGENT_ENABLED=true with a validated model.",
    });
  }

  if (!readiness.model_validated) {
    return emptyResult({
      stopped_reason: "not_ready",
      readiness,
      error: readiness.reasons[0] || "No validated model available for agentic reasoning.",
      clarification_needed:
        "Upload and validate a financial model (validation_status=ready) before running open-ended agentic analysis.",
    });
  }

  let constraints: ScenarioConstraint[] = [];
  if (scenarioId) {
    await hydrateScenarioContext(scenarioId);
    constraints = getScenarioContext(scenarioId)?.constraints ?? [];
  }

  const inputLeverIds = await getWorkspaceInputLeverIds(scope.workspaceId);
  const tools = buildTools({ scope, scenarioId, constraints, inputLeverIds });
  const companyDesc = (await describeCompanyContext(scope)) || "";
  const scenarioDesc = scenarioId
    ? describeScenarioContext(getScenarioContext(scenarioId))
    : "No prior scenario context.";

  const leverList =
    inputLeverIds.size > 0
      ? [...inputLeverIds].slice(0, 60).join(", ")
      : "(lever catalog unavailable — prefer ids from get_model_schema.scenarioLevers)";

  const system = `You are an FP&A scenario reasoning agent. Decompose the user's open-ended question into concrete model lever changes.

Workflow:
1. Call get_model_schema and get_business_context to understand levers, company, industry, and cost-revenue composition.
2. Use search_documents and/or web_research when you need evidence.
3. Optionally call run_what_if to preview impacts (respect constraint violations — never propose blocked levers).
4. Finish by calling propose_parameters with quantitative parameters mapped ONLY to INPUT levers, a causal_chain of reasoning steps, citations, and confidence.
5. For each parameter, set provenance (citation_index into citations[], or source/snippet/url, plus rationale) so every magnitude is traceable.

Rules:
- Never override calculated/output metrics — only input levers from: ${leverList}
- Prefer percent or absolute deltas grounded in research; attach provenance on every lever.
- If constraints block a lever, adjust or explain in clarification_needed.
- Be concise in causal_chain steps; use kinds: decomposition, research, levers, preview.
- Ground assumptions in the company's industry and cost-revenue composition from get_business_context.
- Call run_what_if with the final lever set before propose_parameters so preview and proposal stay aligned.`;

  const userMessage = `User scenario question:
"${nlInput}"

Workspace: ${scope.workspaceId}
${scenarioId ? `Scenario id: ${scenarioId}` : "No scenario id yet (preview may be unavailable)."}

${companyDesc}

ALLOWED INPUT LEVERS: ${leverList}

SCENARIO CONTEXT:
${scenarioDesc}

Investigate and call propose_parameters when ready.`;

  try {
    const loop = await callClaudeAgentLoop({
      system,
      userMessage,
      tools,
      terminalToolName: "propose_parameters",
      terminalSchema: proposeParametersSchema,
      maxSteps: config.AGENT_MAX_STEPS,
      purpose: "agent",
    });

    if (loop.stopped_reason !== "terminal_tool" || !loop.result) {
      return emptyResult({
        agent_trace: loop.steps,
        stopped_reason: loop.stopped_reason,
        readiness,
        clarification_needed:
          "The reasoning agent did not produce a final parameter proposal. Try a more specific question or an explicit % change.",
      });
    }

    const proposed = loop.result as ProposeParametersResult;

    // Strict input-lever validation — reject calculated outputs
    const { kept, rejected } = filterParametersToInputLevers(proposed.parameters, inputLeverIds);
    if (rejected.length > 0) {
      logger.info(
        { rejected },
        "[ScenarioReasoningAgent] Filtered non-input / calculated levers",
      );
    }

    // Final constraint check on suggested lever magnitudes
    const absoluteProbe: Record<string, number> = {};
    for (const p of kept) {
      if (p.suggested_variable_id) absoluteProbe[p.suggested_variable_id] = p.magnitude;
    }
    const validation = validateAgainstConstraints(absoluteProbe, constraints);
    if (!validation.ok) {
      return emptyResult({
        causal_chain: proposed.causal_chain,
        citations: proposed.citations,
        confidence: proposed.confidence,
        agent_trace: loop.steps,
        stopped_reason: "constraint_blocked",
        readiness,
        rejected_non_input_levers: rejected.length ? rejected : undefined,
        constraint_violations: validation.violations.map((v) => ({
          lever: v.lever,
          reason: v.reason,
        })),
        error: validation.violations.map((v) => v.reason).join("; "),
        clarification_needed: `Proposed parameters violate constraints: ${validation.violations
          .map((v) => v.reason)
          .join("; ")}`,
      });
    }

    // Prefer the last successful run_what_if preview P&L from the trace
    let preview_pl: Record<string, number> | undefined;
    for (let i = loop.steps.length - 1; i >= 0; i--) {
      const step = loop.steps[i];
      if (step.tool !== "run_what_if") continue;
      const out = step.output as { pl?: Record<string, number> } | null;
      if (out?.pl && typeof out.pl === "object") {
        preview_pl = out.pl;
        break;
      }
    }

    // Re-run what-if on final proposed levers and reconcile vs last preview
    let final_preview_pl: Record<string, number> | undefined;
    let preview_reconciliation: PreviewReconciliation | undefined;
    if (scenarioId && kept.length > 0) {
      try {
        const overrideParams = kept
          .filter((p) => p.suggested_variable_id)
          .map((p) => ({
            variableId: p.suggested_variable_id!,
            value: p.magnitude,
            delta_type: (p.unit === "absolute" || p.direction === "set"
              ? "absolute"
              : "percent") as "percent" | "absolute",
          }));
        if (overrideParams.length > 0) {
          const finalPreview = await previewSimulationForScenario(scenarioId, overrideParams);
          final_preview_pl = finalPreview.pl;
          if (preview_pl) {
            const diffs: PreviewReconciliation["diffs"] = {};
            let maxAbs = 0;
            const keys = new Set([...Object.keys(preview_pl), ...Object.keys(final_preview_pl)]);
            for (const k of keys) {
              const a = preview_pl[k] ?? 0;
              const b = final_preview_pl[k] ?? 0;
              const abs = Math.abs(a - b);
              if (abs > 1e-6) {
                diffs[k] = { preview: a, final: b, abs_diff: abs };
                if (abs > maxAbs) maxAbs = abs;
              }
            }
            const reconciled = Object.keys(diffs).length === 0;
            preview_reconciliation = {
              reconciled,
              max_abs_diff: maxAbs,
              diffs,
              message: reconciled
                ? "Final lever set matches last run_what_if preview."
                : `Preview drift detected (max abs diff ${maxAbs.toFixed(4)}). Prefer final_preview_pl.`,
            };
          } else {
            preview_pl = final_preview_pl;
            preview_reconciliation = {
              reconciled: true,
              max_abs_diff: 0,
              diffs: {},
              message: "No prior run_what_if; final preview used as source of truth.",
            };
          }
        }
      } catch (e) {
        logger.warn(
          { err: e },
          "[ScenarioReasoningAgent] final preview reconciliation failed",
        );
      }
    }

    // Attach citation provenance when the model omitted per-lever provenance
    const enriched = kept.map((p) => {
      let provenance = p.provenance;
      if (!provenance && proposed.citations.length > 0) {
        const cite = proposed.citations[0];
        provenance = {
          citation_index: 0,
          source: cite.source,
          snippet: cite.snippet,
          url: cite.url,
          rationale: "Defaulted to first research citation; verify magnitude grounding.",
        };
      } else if (provenance?.citation_index != null && proposed.citations[provenance.citation_index]) {
        const cite = proposed.citations[provenance.citation_index];
        provenance = {
          ...provenance,
          source: provenance.source ?? cite.source,
          snippet: provenance.snippet ?? cite.snippet,
          url: provenance.url ?? cite.url,
        };
      }
      return { ...p, provenance };
    });

    let clarification = proposed.clarification_needed ?? undefined;
    if (rejected.length > 0) {
      const note = `Dropped non-input levers (calculated outputs are not overrideable): ${rejected.join(", ")}.`;
      clarification = clarification ? `${clarification}\n${note}` : note;
    }
    if (preview_reconciliation && !preview_reconciliation.reconciled) {
      const note = preview_reconciliation.message || "Preview reconciliation drift detected.";
      clarification = clarification ? `${clarification}\n${note}` : note;
    }

    return {
      parameters: enriched.map((p) => ({
        name: p.name,
        variable_type: p.variable_type,
        direction: p.direction,
        magnitude: p.magnitude,
        unit: p.unit,
        scope: p.scope ?? {},
        member_scope: p.member_scope,
        confidence: p.confidence,
        suggested_variable_id: p.suggested_variable_id,
        provenance: p.provenance,
      })),
      causal_chain: proposed.causal_chain,
      citations: proposed.citations,
      confidence: proposed.confidence,
      clarification_needed: clarification,
      agent_trace: loop.steps,
      stopped_reason: loop.stopped_reason,
      readiness,
      ...(rejected.length ? { rejected_non_input_levers: rejected } : {}),
      ...(preview_pl ? { preview_pl } : {}),
      ...(final_preview_pl ? { final_preview_pl } : {}),
      ...(preview_reconciliation ? { preview_reconciliation } : {}),
    };
  } catch (e) {
    logger.error({ err: e }, "[ScenarioReasoningAgent] failed");
    return emptyResult({
      stopped_reason: "error",
      readiness,
      error: (e as Error).message,
      clarification_needed: `Agentic analysis failed: ${(e as Error).message}`,
    });
  }
}
