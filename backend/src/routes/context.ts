/**
 * Context API routes — build, get, edit, delete company context and model schema.
 */

import { Router } from "express";
import {
  getActiveContext,
  getActiveModel,
  updateContext,
  updateModel,
  deleteContext,
} from "../services/contextEngine.js";
import { buildContextForUser } from "../services/contextEngineFactory.js";
import { pool } from "../db/index.js";
import { requireRole } from "../middleware/rbac.js";
import { validateBody } from "../middleware/validate.js";
import { scopeOf } from "../middleware/workspace.js";
import { logger } from "../logger.js";
import {
  updateContextSchema,
  acknowledgeTieOutSchema,
  updateModelSchemaEndpointSchema,
} from "../schemas/context.js";

export const contextRouter = Router();

// ── Build context from uploaded documents ──
contextRouter.post("/build", requireRole("analyst"), async (req, res) => {
  try {
    const ctx = await buildContextForUser(scopeOf(req));
    return res.status(201).json(ctx);
  } catch (e) {
    logger.error({ err: e }, "[Context] Build failed:");
    const msg = (e as Error).message;
    if (msg.includes("No processed documents")) return res.status(400).json({ error: msg });
    if (msg.includes("ANTHROPIC_API_KEY")) return res.status(503).json({ error: msg });
    return res.status(500).json({ error: "Context build failed: " + msg });
  }
});

// ── Get current context ──
contextRouter.get("/", async (req, res) => {
  try {
    const scope = scopeOf(req);
    const ctx = await getActiveContext(scope);
    if (!ctx) return res.json({ context: null, message: "No context found. Upload documents and build context." });
    const docRes = await pool.query(
      `SELECT document_id, validation_status, ingestion_report, document_kind,
              (workbook_snapshot IS NOT NULL) AS has_snapshot,
              (SELECT COUNT(*)::int FROM jsonb_object_keys(COALESCE(workbook_graph->'sheets', '{}'::jsonb))) AS sheet_count
       FROM documents
       WHERE workspace_id = $1
         AND status = 'ready'
         AND document_kind = 'spreadsheet_model'
       ORDER BY created_at DESC
       LIMIT 1`,
      [scope.workspaceId],
    );
    return res.json({
      context: ctx,
      model_intelligence: docRes.rows.length > 0
        ? {
            document_id: docRes.rows[0].document_id,
            validation_status: docRes.rows[0].validation_status,
            ingestion_report: docRes.rows[0].ingestion_report,
            has_snapshot: docRes.rows[0].has_snapshot,
            sheet_count: docRes.rows[0].sheet_count,
            document_kind: docRes.rows[0].document_kind,
          }
        : null,
      agent: await (async () => {
        try {
          const { getAgentReadiness } = await import("../services/scenarioReasoningAgent.js");
          return await getAgentReadiness(scope.workspaceId);
        } catch {
          return null;
        }
      })(),
    });
  } catch (e) {
    logger.error({ err: e }, "Request failed");
    return res.status(500).json({ error: "Failed to get context" });
  }
});

// ── Update context data ──
contextRouter.put("/", requireRole("analyst"), validateBody(updateContextSchema), async (req, res) => {
  try {
    const existing = await getActiveContext(scopeOf(req));
    if (!existing) return res.status(404).json({ error: "No active context to update" });
    const updated = await updateContext(existing.context_id, req.body);
    return res.json(updated);
  } catch (e) {
    logger.error({ err: e }, "Request failed");
    return res.status(500).json({ error: "Failed to update context" });
  }
});

// ── Acknowledge text-path tie-out variances and activate the model ──
contextRouter.post("/acknowledge-tie-out", requireRole("analyst"), validateBody(acknowledgeTieOutSchema), async (req, res) => {
  try {
    const scope = scopeOf(req);
    const existing = await getActiveContext(scope);
    if (!existing) return res.status(404).json({ error: "No active context" });
    const data = existing.context_data as {
      usability?: string;
      tie_out_variances?: unknown[];
      model_warnings?: string[];
    };
    const note =
      typeof req.body?.note === "string" && req.body.note.trim()
        ? req.body.note.trim()
        : "Analyst acknowledged tie-out variances and activated the model";
    const warnings = [...(data.model_warnings ?? []), `Tie-out override: ${note}`];
    const updated = await updateContext(existing.context_id, {
      usability: "usable",
      model_warnings: warnings,
    } as never);

    // Activate the most recent inactive model for this context (created under needs_review).
    await pool.query(
      `UPDATE user_models SET is_active = true, updated_at = NOW()
       WHERE model_id = (
         SELECT model_id FROM user_models
         WHERE workspace_id = $1 AND source_context_id = $2
         ORDER BY created_at DESC LIMIT 1
       )`,
      [scope.workspaceId, existing.context_id],
    );
    // Ensure only one active model
    await pool.query(
      `UPDATE user_models SET is_active = false
       WHERE workspace_id = $1 AND is_active = true
         AND source_context_id IS DISTINCT FROM $2`,
      [scope.workspaceId, existing.context_id],
    );

    return res.json({
      acknowledged: true,
      context: updated,
      note,
      prior_variances: data.tie_out_variances ?? [],
    });
  } catch (e) {
    logger.error({ err: e }, "Request failed");
    return res.status(500).json({ error: "Failed to acknowledge tie-out" });
  }
});

// ── Delete context (reset) ──
contextRouter.delete("/", requireRole("analyst"), async (req, res) => {
  try {
    await deleteContext(scopeOf(req));
    return res.json({ deleted: true });
  } catch (e) {
    logger.error({ err: e }, "Request failed");
    return res.status(500).json({ error: "Failed to delete context" });
  }
});

// ── Get active model ──
contextRouter.get("/model", async (req, res) => {
  try {
    const model = await getActiveModel(scopeOf(req));
    if (!model) return res.json({ model: null, message: "No model found. Build context from documents first." });
    return res.json({ model });
  } catch (e) {
    logger.error({ err: e }, "Request failed");
    return res.status(500).json({ error: "Failed to get model" });
  }
});

// ── Update model definition ──
contextRouter.put("/model", requireRole("analyst"), validateBody(updateModelSchemaEndpointSchema), async (req, res) => {
  try {
    const scope = scopeOf(req);
    const model = await getActiveModel(scope);
    if (!model) return res.status(404).json({ error: "No active model to update" });
    await updateModel(model.model_id, req.body.model_definition);
    const updated = await getActiveModel(scope);
    return res.json({ model: updated });
  } catch (e) {
    logger.error({ err: e }, "Request failed");
    return res.status(500).json({ error: "Failed to update model" });
  }
});

// ── Check onboarding status (context + model existence) ──
contextRouter.get("/status", async (req, res) => {
  try {
    const scope = scopeOf(req);
    const ctx = await getActiveContext(scope);
    const model = await getActiveModel(scope);
    const ctxData = ctx?.context_data as Record<string, unknown> | undefined;
    const latestSpreadsheet = await pool.query(
      `SELECT validation_status, ingestion_report, document_kind
       FROM documents
       WHERE workspace_id = $1
         AND status = 'ready'
         AND document_kind IN ('spreadsheet_model', 'tabular_data')
       ORDER BY CASE document_kind WHEN 'spreadsheet_model' THEN 0 ELSE 1 END, created_at DESC
       LIMIT 1`,
      [scope.workspaceId],
    );
    return res.json({
      has_context: !!ctx,
      has_model: !!model,
      company_name: ctx?.company_name || null,
      industry: ctx?.industry || null,
      model_name: model?.name || null,
      currency: (ctxData?.currency as string) || null,
      currency_unit: (ctxData?.currency_unit as string) || null,
      validation_status: latestSpreadsheet.rows[0]?.validation_status || null,
      ingestion_report: latestSpreadsheet.rows[0]?.ingestion_report || null,
      ready: !!(ctx && model),
    });
  } catch (e) {
    logger.error({ err: e }, "Request failed");
    return res.status(500).json({ error: "Failed to check status" });
  }
});

// ── Validate latest spreadsheet model schema (analyst gate + runtime proof) ──
contextRouter.post("/model/validate", requireRole("analyst"), async (req, res) => {
  try {
    const scope = scopeOf(req);
    const targetDocId = req.body?.document_id as string | undefined;

    const docRes = targetDocId
      ? await pool.query(
          `SELECT document_id, model_schema, workbook_graph, workbook_snapshot, ingestion_report, original_filename
           FROM documents
           WHERE document_id = $1 AND workspace_id = $2 AND document_kind = 'spreadsheet_model'`,
          [targetDocId, scope.workspaceId],
        )
      : await pool.query(
          // Prefer docs that already have a schema, but still surface the latest
          // spreadsheet_model so we can return an actionable "build context" error
          // instead of a confusing 404 when the user validates before building.
          `SELECT document_id, model_schema, workbook_graph, workbook_snapshot, ingestion_report, original_filename
           FROM documents
           WHERE workspace_id = $1
             AND status = 'ready'
             AND document_kind = 'spreadsheet_model'
           ORDER BY CASE WHEN model_schema IS NOT NULL THEN 0 ELSE 1 END, created_at DESC
           LIMIT 1`,
          [scope.workspaceId],
        );
    if (docRes.rows.length === 0) {
      return res.status(404).json({
        error:
          "No spreadsheet model found for validation in this workspace. Upload an .xlsx with formulas, then click Build Context.",
      });
    }

    const row = docRes.rows[0] as {
      document_id: string;
      model_schema: unknown;
      workbook_graph: unknown;
      workbook_snapshot: unknown;
      ingestion_report: unknown;
      original_filename?: string;
    };

    if (!row.model_schema || !row.workbook_graph) {
      return res.status(422).json({
        error:
          `Model schema missing for ${row.original_filename || "spreadsheet"}. Click Build Context first, then Mark Model Validated.`,
        needs_context_build: true,
        document_id: row.document_id,
      });
    }

    const { buildXlsxRuntime } = await import("../services/xlsxRuntime.js");
    const build = buildXlsxRuntime(
      `${row.document_id}:validate`,
      row.workbook_graph as never,
      row.model_schema as never,
      row.workbook_snapshot as never,
    );

    if (!build.ok || !build.runtime) {
      return res.status(422).json({
        validated: false,
        error: "Runtime validation failed — model cannot be marked ready",
        reason: build.reason,
        errors: build.errors,
        warnings: build.warnings,
        unbound_levers: build.unboundLevers,
        unbound_outputs: build.unboundOutputs,
      });
    }

    // Baseline evaluation must complete without hard formula errors on all outputs
    const baseline = build.runtime.evaluate({});
    const nanOutputs = Object.entries(baseline)
      .filter(([, v]) => typeof v === "number" && !Number.isFinite(v))
      .map(([k]) => k);
    if (nanOutputs.length > 0 || build.runtime.lastEvaluationErrors.length > 0) {
      return res.status(422).json({
        validated: false,
        error: "Baseline evaluation produced formula errors",
        errors: [
          ...build.runtime.lastEvaluationErrors,
          ...(nanOutputs.length ? [`Non-numeric outputs: ${nanOutputs.join(", ")}`] : []),
        ],
        warnings: build.warnings,
        bound_levers: build.boundLevers,
        bound_outputs: build.boundOutputs,
      });
    }

    const schema = row.model_schema as {
      outputMetrics?: Array<{ id?: string; sheet?: string; cell?: string; row?: number }>;
    };
    const keyOutputs = (schema.outputMetrics || [])
      .filter((m) => m.sheet && m.cell)
      .map((m) => ({ id: m.id, sheet: m.sheet!, cell: m.cell! }));

    const { reconcileFidelity } = await import("../services/fidelityReconciliation.js");
    const fidelity = reconcileFidelity(
      row.workbook_snapshot as never,
      keyOutputs,
    );

    if (!fidelity.ready) {
      const existingBlocked = await getActiveContext(scope);
      if (existingBlocked) {
        await updateContext(existingBlocked.context_id, {
          validation_status: "needs_validation",
          runtime_validation: {
            bound_levers: build.boundLevers,
            bound_outputs: build.boundOutputs,
            warnings: build.warnings,
            fidelity,
          },
        } as never);
      }
      await pool.query(
        `UPDATE documents SET validation_status = 'needs_validation', updated_at = NOW() WHERE document_id = $1`,
        [row.document_id],
      );
      return res.status(422).json({
        validated: false,
        error: "Fidelity reconciliation failed — HyperFormula values diverge from Excel cached results",
        validation_status: "needs_validation",
        fidelity,
        bound_levers: build.boundLevers,
        bound_outputs: build.boundOutputs,
        warnings: build.warnings,
      });
    }

    const documentId = row.document_id;
    await pool.query(
      `UPDATE documents
       SET validation_status = 'ready',
           updated_at = NOW()
       WHERE document_id = $1`,
      [documentId],
    );

    const existing = await getActiveContext(scope);
    if (existing) {
      await updateContext(existing.context_id, {
        validation_status: "ready",
        runtime_validation: {
          bound_levers: build.boundLevers,
          bound_outputs: build.boundOutputs,
          warnings: build.warnings,
          fidelity,
        },
      } as never);
    }

    return res.json({
      validated: true,
      document_id: documentId,
      validation_status: "ready",
      bound_levers: build.boundLevers,
      bound_outputs: build.boundOutputs,
      warnings: build.warnings,
      fidelity,
      ingestion_report: row.ingestion_report || null,
    });
  } catch (e) {
    logger.error({ err: e }, "Request failed");
    return res.status(500).json({ error: "Failed to validate model schema" });
  }
});
