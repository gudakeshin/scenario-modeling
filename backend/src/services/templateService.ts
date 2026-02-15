/**
 * Scenario Template Library
 *
 * Allows saving scenario configurations as reusable templates,
 * browsing a gallery, cloning templates into new scenarios,
 * and versioning / sharing.
 */

import { pool, getDefaultUserId } from "../db/index.js";

export interface Template {
  template_id: string;
  name: string;
  description: string | null;
  parameter_set: { variable_id: string; value: number; label: string }[];
  model_version_hash: string | null;
  is_shared: boolean;
  sharing_scope: string;
  version: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

// ── CRUD ──

export async function listTemplates(scope?: string): Promise<Template[]> {
  let query = `SELECT * FROM scenario_templates`;
  const params: string[] = [];
  if (scope === "shared") {
    query += ` WHERE is_shared = true`;
  } else if (scope === "private") {
    const userId = await getDefaultUserId();
    query += ` WHERE created_by = $1 AND is_shared = false`;
    params.push(userId);
  }
  query += ` ORDER BY updated_at DESC`;
  const r = await pool.query(query, params);
  return r.rows;
}

export async function getTemplate(templateId: string): Promise<Template | null> {
  const r = await pool.query("SELECT * FROM scenario_templates WHERE template_id = $1", [templateId]);
  return r.rows[0] || null;
}

export async function createTemplate(data: {
  name: string;
  description?: string;
  parameter_set: { variable_id: string; value: number; label: string }[];
  model_version_hash?: string;
  is_shared?: boolean;
  sharing_scope?: string;
}): Promise<Template> {
  const userId = await getDefaultUserId();
  const r = await pool.query(
    `INSERT INTO scenario_templates (name, description, parameter_set, model_version_hash, is_shared, sharing_scope, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      data.name,
      data.description || null,
      JSON.stringify(data.parameter_set),
      data.model_version_hash || "v0",
      data.is_shared ?? false,
      data.sharing_scope || "private",
      userId,
    ]
  );
  return r.rows[0];
}

export async function updateTemplate(
  templateId: string,
  updates: Partial<{ name: string; description: string; parameter_set: unknown; is_shared: boolean; sharing_scope: string }>
): Promise<Template | null> {
  const fields: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  if (updates.name !== undefined) { fields.push(`name = $${i++}`); values.push(updates.name); }
  if (updates.description !== undefined) { fields.push(`description = $${i++}`); values.push(updates.description); }
  if (updates.parameter_set !== undefined) {
    fields.push(`parameter_set = $${i++}`, `version = version + 1`);
    values.push(JSON.stringify(updates.parameter_set));
  }
  if (updates.is_shared !== undefined) { fields.push(`is_shared = $${i++}`); values.push(updates.is_shared); }
  if (updates.sharing_scope !== undefined) { fields.push(`sharing_scope = $${i++}`); values.push(updates.sharing_scope); }
  if (fields.length === 0) return getTemplate(templateId);
  fields.push("updated_at = NOW()");
  values.push(templateId);
  const r = await pool.query(
    `UPDATE scenario_templates SET ${fields.join(", ")} WHERE template_id = $${i} RETURNING *`,
    values
  );
  return r.rows[0] || null;
}

export async function deleteTemplate(templateId: string): Promise<boolean> {
  const r = await pool.query("DELETE FROM scenario_templates WHERE template_id = $1", [templateId]);
  return (r.rowCount ?? 0) > 0;
}

// ── Clone template → new scenario ──

export async function cloneTemplateToScenario(templateId: string, nlInput?: string): Promise<string> {
  const tpl = await getTemplate(templateId);
  if (!tpl) throw new Error("Template not found");

  const userId = await getDefaultUserId();
  const name = `${tpl.name} (clone)`;
  const input = nlInput || `Cloned from template: ${tpl.name}`;

  const sRes = await pool.query(
    `INSERT INTO scenarios (name, nl_input, status, creator_id, model_version_hash)
     VALUES ($1, $2, 'draft', $3, $4) RETURNING scenario_id`,
    [name, input, userId, tpl.model_version_hash || "v0"]
  );
  const scenarioId = sRes.rows[0].scenario_id;

  const params = tpl.parameter_set as { variable_id: string; value: number; label: string }[];
  for (const p of params) {
    await pool.query(
      `INSERT INTO scenario_parameters (scenario_id, extracted_name, mapped_variable_id, scenario_value, confidence_score, status)
       VALUES ($1, $2, $3, $4, 1.0, 'pending')`,
      [scenarioId, p.label || p.variable_id, p.variable_id, p.value]
    );
  }

  return scenarioId;
}

// ── Save scenario as template ──

export async function saveScenarioAsTemplate(
  scenarioId: string,
  name: string,
  description?: string,
  isShared = false
): Promise<Template> {
  const sRes = await pool.query("SELECT model_version_hash FROM scenarios WHERE scenario_id = $1", [scenarioId]);
  if (sRes.rows.length === 0) throw new Error("Scenario not found");

  const pRes = await pool.query(
    "SELECT extracted_name, mapped_variable_id, scenario_value FROM scenario_parameters WHERE scenario_id = $1 AND status != 'rejected'",
    [scenarioId]
  );

  const paramSet = pRes.rows.map((r: { extracted_name: string; mapped_variable_id: string; scenario_value: number }) => ({
    variable_id: r.mapped_variable_id,
    value: Number(r.scenario_value),
    label: r.extracted_name,
  }));

  return createTemplate({
    name,
    description,
    parameter_set: paramSet,
    model_version_hash: sRes.rows[0].model_version_hash,
    is_shared: isShared,
    sharing_scope: isShared ? "team" : "private",
  });
}
