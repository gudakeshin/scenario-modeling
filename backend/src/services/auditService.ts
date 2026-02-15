import { pool, getDefaultUserId } from "../db/index.js";

export interface AuditEntry {
  audit_id: string;
  scenario_id: string;
  action_type: string;
  user_id: string;
  action_details: Record<string, unknown> | null;
  timestamp: string;
}

export async function logAudit(
  scenarioId: string,
  actionType: string,
  details?: Record<string, unknown>,
  userId?: string
): Promise<void> {
  const uid = userId || await getDefaultUserId();
  await pool.query(
    `INSERT INTO audit_trail (scenario_id, action_type, user_id, action_details) VALUES ($1, $2, $3, $4)`,
    [scenarioId, actionType, uid, details ? JSON.stringify(details) : null]
  );
}

export async function getAuditTrail(
  filters: { scenario_id?: string; action_type?: string; limit?: number; offset?: number }
): Promise<{ entries: AuditEntry[]; total: number }> {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;
  if (filters.scenario_id) {
    conditions.push(`scenario_id = $${idx++}`);
    values.push(filters.scenario_id);
  }
  if (filters.action_type) {
    conditions.push(`action_type = $${idx++}`);
    values.push(filters.action_type);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = Math.min(filters.limit || 100, 500);
  const offset = filters.offset || 0;

  const countRes = await pool.query(`SELECT COUNT(*) FROM audit_trail ${where}`, values);
  const total = parseInt(countRes.rows[0].count, 10);

  const dataRes = await pool.query(
    `SELECT audit_id, scenario_id, action_type, user_id, action_details, timestamp
     FROM audit_trail ${where} ORDER BY timestamp DESC LIMIT $${idx++} OFFSET $${idx}`,
    [...values, limit, offset]
  );
  return { entries: dataRes.rows, total };
}

export async function exportAuditCsv(scenarioId?: string): Promise<string> {
  const { entries } = await getAuditTrail({ scenario_id: scenarioId, limit: 500 });
  const lines = ["audit_id,scenario_id,action_type,user_id,timestamp,details"];
  for (const e of entries) {
    const details = e.action_details ? JSON.stringify(e.action_details).replace(/"/g, '""') : "";
    lines.push(`"${e.audit_id}","${e.scenario_id}","${e.action_type}","${e.user_id}","${e.timestamp}","${details}"`);
  }
  return lines.join("\n");
}

export async function exportAuditJson(scenarioId?: string): Promise<AuditEntry[]> {
  const { entries } = await getAuditTrail({ scenario_id: scenarioId, limit: 500 });
  return entries;
}
