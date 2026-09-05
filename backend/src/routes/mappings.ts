import { Router } from "express";
import {
  listMappings,
  getMapping,
  createMapping,
  updateMapping,
  deleteMapping,
  suggestMappings,
  importMappingsCsv,
  exportMappingsCsv,
} from "../services/mappingService.js";
import { logger } from "../logger.js";

export const mappingsRouter = Router();

mappingsRouter.get("/", async (req, res) => {
  try {
    const activeOnly = req.query.active !== "false";
    const mappings = await listMappings(activeOnly);
    return res.json({ mappings });
  } catch (e) {
    logger.error({ err: e }, "Request failed");
    return res.status(500).json({ error: "Failed to list mappings" });
  }
});

mappingsRouter.get("/export", async (req, res) => {
  try {
    const csv = await exportMappingsCsv();
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=mappings.csv");
    return res.send(csv);
  } catch (e) {
    logger.error({ err: e }, "Request failed");
    return res.status(500).json({ error: "Failed to export mappings" });
  }
});

mappingsRouter.post("/import", async (req, res) => {
  try {
    const csv = typeof req.body === "string" ? req.body : req.body?.csv ?? req.body?.data ?? "";
    if (!csv || typeof csv !== "string") {
      return res.status(400).json({ error: "csv or data string required" });
    }
    const result = await importMappingsCsv(csv);
    return res.json(result);
  } catch (e) {
    logger.error({ err: e }, "Request failed");
    return res.status(500).json({ error: "Failed to import mappings" });
  }
});

mappingsRouter.post("/suggest", async (req, res) => {
  try {
    const term = req.body?.term ?? req.query.term;
    if (typeof term !== "string" || !term.trim()) {
      return res.status(400).json({ error: "term is required" });
    }
    const limit = Math.min(Number(req.body?.limit ?? req.query.limit) || 5, 20);
    const suggestions = await suggestMappings(term.trim(), limit);
    return res.json({ suggestions });
  } catch (e) {
    logger.error({ err: e }, "Request failed");
    return res.status(500).json({ error: "Failed to suggest mappings" });
  }
});

mappingsRouter.get("/:id", async (req, res) => {
  try {
    const mapping = await getMapping(req.params.id);
    if (!mapping) return res.status(404).json({ error: "Mapping not found" });
    return res.json(mapping);
  } catch (e) {
    logger.error({ err: e }, "Request failed");
    return res.status(500).json({ error: "Failed to get mapping" });
  }
});

mappingsRouter.post("/", async (req, res) => {
  try {
    const { business_term, model_variable_id, synonyms } = req.body;
    if (typeof business_term !== "string" || typeof model_variable_id !== "string") {
      return res.status(400).json({ error: "business_term and model_variable_id are required" });
    }
    const mapping = await createMapping(
      business_term,
      model_variable_id,
      Array.isArray(synonyms) ? synonyms : []
    );
    return res.status(201).json(mapping);
  } catch (e) {
    logger.error({ err: e }, "Request failed");
    return res.status(500).json({ error: "Failed to create mapping" });
  }
});

mappingsRouter.put("/:id", async (req, res) => {
  try {
    const { business_term, model_variable_id, synonyms } = req.body;
    const mapping = await updateMapping(req.params.id, {
      ...(business_term !== undefined && { business_term }),
      ...(model_variable_id !== undefined && { model_variable_id }),
      ...(synonyms !== undefined && { synonyms: Array.isArray(synonyms) ? synonyms : [] }),
    });
    if (!mapping) return res.status(404).json({ error: "Mapping not found" });
    return res.json(mapping);
  } catch (e) {
    logger.error({ err: e }, "Request failed");
    return res.status(500).json({ error: "Failed to update mapping" });
  }
});

mappingsRouter.delete("/:id", async (req, res) => {
  try {
    const ok = await deleteMapping(req.params.id);
    if (!ok) return res.status(404).json({ error: "Mapping not found" });
    return res.status(204).send();
  } catch (e) {
    logger.error({ err: e }, "Request failed");
    return res.status(500).json({ error: "Failed to delete mapping" });
  }
});
