/**
 * Planning connections API — CRUD, test, browse models, import snapshots.
 * Feature-gated by ENABLE_PLANNING_CONNECTORS.
 */

import { Router } from "express";
import { z } from "zod";
import { requireRole } from "../middleware/rbac.js";
import { scopeOf } from "../middleware/workspace.js";
import { validateBody } from "../middleware/validate.js";
import {
  createConnectionSchema,
  updateConnectionSchema,
  importModelSchema,
  testConnectionSchema,
} from "../schemas/connections.js";
import {
  ConnectionError,
  createConnection,
  listConnections,
  getConnection,
  updateConnection,
  deleteConnection,
  testConnection,
  testConnectionDraft,
  listModels,
  getModelMetadata,
  listIntegrationEvents,
} from "../services/connectionService.js";
import {
  startImport,
  getSnapshot,
  listSnapshots,
  refreshImport,
  cancelImport,
} from "../services/externalModelImport.js";
import { buildMappingPreview } from "../services/externalModelMapping.js";
import { isPlanningConnectorsEnabled } from "../config.js";
import { logger } from "../logger.js";

export const connectionsRouter = Router();

function requireConnectors(
  _req: import("express").Request,
  res: import("express").Response,
  next: import("express").NextFunction,
) {
  if (!isPlanningConnectorsEnabled()) {
    return res.status(503).json({
      error: "Planning connectors are disabled",
      code: "PLANNING_CONNECTORS_DISABLED",
    });
  }
  next();
}

connectionsRouter.use(requireConnectors);

function handleConnError(e: unknown, res: import("express").Response) {
  if (e instanceof ConnectionError) {
    return res.status(e.status).json({ error: e.message });
  }
  logger.error({ err: e }, "Connections route error");
  return res.status(500).json({ error: (e as Error).message || "Internal error" });
}

// ── Import status (before /:id so "imports" is not captured) ──

connectionsRouter.get("/imports", requireRole("analyst"), async (req, res) => {
  try {
    const connectionId =
      typeof req.query.connection_id === "string" ? req.query.connection_id : undefined;
    const parsedLimit = Number(req.query.limit ?? 50);
    const limit = Number.isFinite(parsedLimit)
      ? Math.min(Math.max(Math.trunc(parsedLimit), 1), 200)
      : 50;
    const snapshots = await listSnapshots(req.workspace!.workspaceId, connectionId, limit);
    return res.json({ imports: snapshots });
  } catch (e) {
    return handleConnError(e, res);
  }
});

connectionsRouter.get("/imports/:snapshotId", requireRole("analyst"), async (req, res) => {
  try {
    const snap = await getSnapshot(req.workspace!.workspaceId, req.params.snapshotId);
    if (!snap) return res.status(404).json({ error: "Snapshot not found" });
    return res.json(snap);
  } catch (e) {
    return handleConnError(e, res);
  }
});

connectionsRouter.post(
  "/imports/:snapshotId/refresh",
  requireRole("analyst"),
  async (req, res) => {
    try {
      const result = await refreshImport(scopeOf(req), req.params.snapshotId);
      return res.status(202).json(result);
    } catch (e) {
      return handleConnError(e, res);
    }
  },
);

connectionsRouter.post(
  "/imports/:snapshotId/cancel",
  requireRole("analyst"),
  async (req, res) => {
    try {
      const result = await cancelImport(scopeOf(req), req.params.snapshotId);
      return res.json(result);
    } catch (e) {
      return handleConnError(e, res);
    }
  },
);

// ── Draft test (before /:id) ──

connectionsRouter.post(
  "/test",
  requireRole("analyst"),
  validateBody(testConnectionSchema),
  async (req, res) => {
    try {
      const result = await testConnectionDraft(req.body);
      return res.json(result);
    } catch (e) {
      return handleConnError(e, res);
    }
  },
);

// ── CRUD ──

connectionsRouter.post(
  "/",
  requireRole("admin"),
  validateBody(createConnectionSchema),
  async (req, res) => {
    try {
      const row = await createConnection(scopeOf(req), req.body);
      return res.status(201).json(row);
    } catch (e) {
      return handleConnError(e, res);
    }
  },
);

connectionsRouter.get("/", requireRole("analyst"), async (req, res) => {
  try {
    const rows = await listConnections(req.workspace!.workspaceId);
    return res.json({ connections: rows });
  } catch (e) {
    return handleConnError(e, res);
  }
});

connectionsRouter.get("/:id", requireRole("analyst"), async (req, res) => {
  try {
    const row = await getConnection(req.workspace!.workspaceId, req.params.id);
    if (!row) return res.status(404).json({ error: "Connection not found" });
    return res.json(row);
  } catch (e) {
    return handleConnError(e, res);
  }
});

connectionsRouter.get("/:id/events", requireRole("analyst"), async (req, res) => {
  try {
    const parsedLimit = Number(req.query.limit ?? 50);
    const parsedOffset = Number(req.query.offset ?? 0);
    const limit = Number.isFinite(parsedLimit)
      ? Math.min(Math.max(Math.trunc(parsedLimit), 1), 200)
      : 50;
    const offset = Number.isFinite(parsedOffset) ? Math.max(Math.trunc(parsedOffset), 0) : 0;
    const events = await listIntegrationEvents(
      req.workspace!.workspaceId,
      req.params.id,
      limit,
      offset,
    );
    return res.json({ events, limit, offset });
  } catch (e) {
    return handleConnError(e, res);
  }
});

connectionsRouter.put(
  "/:id",
  requireRole("admin"),
  validateBody(updateConnectionSchema),
  async (req, res) => {
    try {
      const row = await updateConnection(scopeOf(req), req.params.id, req.body);
      return res.json(row);
    } catch (e) {
      return handleConnError(e, res);
    }
  },
);

connectionsRouter.delete("/:id", requireRole("admin"), async (req, res) => {
  try {
    await deleteConnection(scopeOf(req), req.params.id);
    return res.status(204).send();
  } catch (e) {
    return handleConnError(e, res);
  }
});

connectionsRouter.post("/:id/test", requireRole("analyst"), async (req, res) => {
  try {
    const result = await testConnection(scopeOf(req), req.params.id);
    return res.json(result);
  } catch (e) {
    return handleConnError(e, res);
  }
});

// ── Browse ──

connectionsRouter.get("/:id/models", requireRole("analyst"), async (req, res) => {
  try {
    const models = await listModels(req.workspace!.workspaceId, req.params.id);
    return res.json({ models });
  } catch (e) {
    return handleConnError(e, res);
  }
});

connectionsRouter.get(
  "/:id/models/:modelId/metadata",
  requireRole("analyst"),
  async (req, res) => {
    try {
      const metadata = await getModelMetadata(
        req.workspace!.workspaceId,
        req.params.id,
        req.params.modelId,
      );
      return res.json(metadata);
    } catch (e) {
      return handleConnError(e, res);
    }
  },
);

connectionsRouter.get(
  "/:id/models/:modelId/mapping-preview",
  requireRole("analyst"),
  async (req, res) => {
    try {
      const metadata = await getModelMetadata(
        req.workspace!.workspaceId,
        req.params.id,
        req.params.modelId,
      );
      return res.json(buildMappingPreview(metadata));
    } catch (e) {
      return handleConnError(e, res);
    }
  },
);

connectionsRouter.post(
  "/:id/models/:modelId/import",
  requireRole("analyst"),
  validateBody(importModelSchema),
  async (req, res) => {
    try {
      const result = await startImport(
        scopeOf(req),
        req.params.id,
        req.params.modelId,
        req.body.fact_query ?? {},
      );
      return res.status(202).json(result);
    } catch (e) {
      return handleConnError(e, res);
    }
  },
);

const writebackSchema = z.object({
  scenario_id: z.string().uuid(),
  measure_values: z
    .array(
      z.object({
        measure_id: z.string().min(1),
        member_key: z.string().min(1),
        value: z.number().finite(),
      }),
    )
    .min(1),
  target_version_member: z.string().optional(),
  idempotency_key: z.string().min(8),
});

connectionsRouter.post(
  "/:id/writeback",
  requireRole("approver"),
  validateBody(writebackSchema),
  async (req, res) => {
    try {
      const scope = scopeOf(req);
      const { writeBackToSac } = await import("../connectors/sacWriteback.js");
      const result = await writeBackToSac({
        connection_id: req.params.id,
        workspace_id: scope.workspaceId,
        scenario_id: req.body.scenario_id,
        user_id: req.user!.userId,
        target_version_member: req.body.target_version_member,
        measure_values: req.body.measure_values,
        idempotency_key: req.body.idempotency_key,
      });
      return res.json(result);
    } catch (e) {
      return handleConnError(e, res);
    }
  },
);
