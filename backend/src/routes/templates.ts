import { Router } from "express";
import {
  listTemplates,
  getTemplate,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  cloneTemplateToScenario,
  saveScenarioAsTemplate,
} from "../services/templateService.js";
import { requireRole } from "../middleware/rbac.js";
import { assertCanWriteScenario } from "../services/authzService.js";
import { logger } from "../logger.js";

export const templatesRouter = Router();

function authzError(e: unknown) {
  return (e as { status?: number }).status;
}

templatesRouter.get("/", async (req, res) => {
  try {
    const scope = req.query.scope as string | undefined;
    const templates = await listTemplates(req.user!.userId, scope);
    return res.json({ templates });
  } catch (e) {
    logger.error({ err: e }, "Request failed");
    return res.status(500).json({ error: "Failed to list templates" });
  }
});

templatesRouter.get("/:id", async (req, res) => {
  try {
    const t = await getTemplate(req.params.id);
    if (!t) return res.status(404).json({ error: "Template not found" });
    return res.json(t);
  } catch (e) {
    logger.error({ err: e }, "Request failed");
    return res.status(500).json({ error: "Failed to get template" });
  }
});

templatesRouter.post("/", requireRole("analyst"), async (req, res) => {
  try {
    const { name, description, parameter_set, model_version_hash, is_shared, sharing_scope } = req.body;
    if (!name || !parameter_set) return res.status(400).json({ error: "name and parameter_set required" });
    const t = await createTemplate(req.user!.userId, { name, description, parameter_set, model_version_hash, is_shared, sharing_scope });
    return res.status(201).json(t);
  } catch (e) {
    logger.error({ err: e }, "Request failed");
    return res.status(500).json({ error: "Failed to create template" });
  }
});

templatesRouter.put("/:id", requireRole("analyst"), async (req, res) => {
  try {
    const t = await updateTemplate(req.params.id, req.body);
    if (!t) return res.status(404).json({ error: "Template not found" });
    return res.json(t);
  } catch (e) {
    logger.error({ err: e }, "Request failed");
    return res.status(500).json({ error: "Failed to update template" });
  }
});

templatesRouter.delete("/:id", requireRole("analyst"), async (req, res) => {
  try {
    const ok = await deleteTemplate(req.params.id);
    if (!ok) return res.status(404).json({ error: "Template not found" });
    return res.json({ ok: true });
  } catch (e) {
    logger.error({ err: e }, "Request failed");
    return res.status(500).json({ error: "Failed to delete template" });
  }
});

// Clone template → new scenario
templatesRouter.post("/:id/clone", requireRole("analyst"), async (req, res) => {
  try {
    const nlInput = req.body.nl_input as string | undefined;
    const scenarioId = await cloneTemplateToScenario(req.params.id, req.user!.userId, nlInput);
    return res.status(201).json({ scenario_id: scenarioId });
  } catch (e) {
    const msg = (e as Error).message;
    if (msg === "Template not found") return res.status(404).json({ error: msg });
    logger.error({ err: e }, "Request failed");
    return res.status(500).json({ error: "Failed to clone template" });
  }
});

// Save scenario as template
templatesRouter.post("/from-scenario/:scenarioId", requireRole("analyst"), async (req, res) => {
  try {
    const { name, description, is_shared } = req.body;
    if (!name) return res.status(400).json({ error: "name required" });
    await assertCanWriteScenario(req.user!.userId, req.user!.role, req.params.scenarioId);
    const t = await saveScenarioAsTemplate(req.params.scenarioId, req.user!.userId, name, description, is_shared);
    return res.status(201).json(t);
  } catch (e) {
    const status = authzError(e);
    if (status) return res.status(status).json({ error: (e as Error).message });
    const msg = (e as Error).message;
    if (msg === "Scenario not found") return res.status(404).json({ error: msg });
    logger.error({ err: e }, "Request failed");
    return res.status(500).json({ error: "Failed to save as template" });
  }
});
