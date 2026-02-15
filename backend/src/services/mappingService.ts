import { pool } from "../db/index.js";

export interface Mapping {
  mapping_id: string;
  business_term: string;
  model_variable_id: string;
  synonyms: string[] | null;
  confidence_weight: number;
  is_active: boolean;
}

export interface MappingSuggestion {
  model_variable_id: string;
  business_term: string;
  score: number;
}

function levenshtein(a: string, b: string): number {
  const an = a.length;
  const bn = b.length;
  const dp: number[][] = Array(an + 1)
    .fill(null)
    .map(() => Array(bn + 1).fill(0));
  for (let i = 0; i <= an; i++) dp[i][0] = i;
  for (let j = 0; j <= bn; j++) dp[0][j] = j;
  for (let i = 1; i <= an; i++) {
    for (let j = 1; j <= bn; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  return dp[an][bn];
}

function similarity(s1: string, s2: string): number {
  const a = s1.toLowerCase().trim();
  const b = s2.toLowerCase().trim();
  if (a === b) return 1;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  const dist = levenshtein(a, b);
  return 1 - dist / maxLen;
}

export async function listMappings(activeOnly = true): Promise<Mapping[]> {
  const r = await pool.query(
    `SELECT mapping_id, business_term, model_variable_id, synonyms, confidence_weight, is_active
     FROM model_mappings ${activeOnly ? "WHERE is_active = true" : ""}
     ORDER BY business_term`
  );
  return r.rows.map((row) => ({
    ...row,
    synonyms: row.synonyms || [],
  }));
}

export async function getMapping(id: string): Promise<Mapping | null> {
  const r = await pool.query(
    `SELECT mapping_id, business_term, model_variable_id, synonyms, confidence_weight, is_active
     FROM model_mappings WHERE mapping_id = $1`,
    [id]
  );
  if (!r.rows[0]) return null;
  return { ...r.rows[0], synonyms: r.rows[0].synonyms || [] };
}

export async function createMapping(
  business_term: string,
  model_variable_id: string,
  synonyms: string[] = []
): Promise<Mapping> {
  const r = await pool.query(
    `INSERT INTO model_mappings (business_term, model_variable_id, synonyms)
     VALUES ($1, $2, $3)
     RETURNING mapping_id, business_term, model_variable_id, synonyms, confidence_weight, is_active`,
    [business_term.trim(), model_variable_id.trim(), synonyms.length ? synonyms : null]
  );
  const row = r.rows[0];
  return { ...row, synonyms: row.synonyms || [] };
}

export async function updateMapping(
  id: string,
  updates: { business_term?: string; model_variable_id?: string; synonyms?: string[] }
): Promise<Mapping | null> {
  const fields: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  if (updates.business_term !== undefined) {
    fields.push(`business_term = $${i++}`);
    values.push(updates.business_term.trim());
  }
  if (updates.model_variable_id !== undefined) {
    fields.push(`model_variable_id = $${i++}`);
    values.push(updates.model_variable_id.trim());
  }
  if (updates.synonyms !== undefined) {
    fields.push(`synonyms = $${i++}`);
    values.push(updates.synonyms.length ? updates.synonyms : null);
  }
  if (fields.length === 0) return getMapping(id);
  fields.push(`updated_at = NOW()`);
  values.push(id);
  const r = await pool.query(
    `UPDATE model_mappings SET ${fields.join(", ")} WHERE mapping_id = $${i} RETURNING mapping_id, business_term, model_variable_id, synonyms, confidence_weight, is_active`,
    values
  );
  if (!r.rows[0]) return null;
  return { ...r.rows[0], synonyms: r.rows[0].synonyms || [] };
}

export async function deleteMapping(id: string): Promise<boolean> {
  const r = await pool.query("DELETE FROM model_mappings WHERE mapping_id = $1 RETURNING 1", [id]);
  return (r.rowCount ?? 0) > 0;
}

export async function suggestMappings(term: string, limit = 5): Promise<MappingSuggestion[]> {
  const rows = await pool.query(
    `SELECT mapping_id, business_term, model_variable_id, synonyms FROM model_mappings WHERE is_active = true`
  );
  const t = term.toLowerCase().trim();
  const scored: { model_variable_id: string; business_term: string; score: number }[] = [];
  for (const row of rows.rows) {
    const terms = [row.business_term.toLowerCase(), ...(row.synonyms || []).map((s: string) => s.toLowerCase())];
    let best = 0;
    for (const c of terms) {
      const s = similarity(t, c);
      if (s > best) best = s;
    }
    if (best > 0.3) {
      scored.push({
        model_variable_id: row.model_variable_id,
        business_term: row.business_term,
        score: Math.round(best * 100) / 100,
      });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

export async function resolveToModelVariable(term: string): Promise<string | null> {
  const r = await pool.query(
    `SELECT model_variable_id FROM model_mappings WHERE is_active = true AND (LOWER(business_term) = LOWER($1) OR $1 = ANY(SELECT LOWER(unnest(synonyms)))) LIMIT 1`,
    [term.trim()]
  );
  if (r.rows[0]) return r.rows[0].model_variable_id;
  const suggestions = await suggestMappings(term, 1);
  return suggestions[0]?.score >= 0.8 ? suggestions[0].model_variable_id : null;
}

export async function importMappingsCsv(csvText: string): Promise<{ imported: number; errors: string[] }> {
  const lines = csvText.split(/\r?\n/).filter((l) => l.trim());
  const errors: string[] = [];
  let imported = 0;
  const header = lines[0]?.toLowerCase();
  const hasHeader = header?.includes("business_term") || header?.includes("model_variable");
  const start = hasHeader ? 1 : 0;
  for (let i = start; i < lines.length; i++) {
    const parts = lines[i].split(",").map((p) => p.trim().replace(/^"|"$/g, ""));
    const business_term = parts[0];
    const model_variable_id = parts[1] || parts[2] || "";
    const synonyms = parts[2] ? parts[2].split(";").map((s) => s.trim()).filter(Boolean) : [];
    if (!business_term || !model_variable_id) {
      errors.push(`Row ${i + 1}: missing business_term or model_variable_id`);
      continue;
    }
    try {
      await pool.query(
        `INSERT INTO model_mappings (business_term, model_variable_id, synonyms)
         VALUES ($1, $2, $3)
         ON CONFLICT (business_term, model_variable_id) DO UPDATE SET synonyms = $3, updated_at = NOW()`,
        [business_term, model_variable_id, synonyms.length ? synonyms : null]
      );
      imported++;
    } catch (e) {
      errors.push(`Row ${i + 1}: ${(e as Error).message}`);
    }
  }
  return { imported, errors };
}

export async function exportMappingsCsv(): Promise<string> {
  const rows = await pool.query(
    `SELECT business_term, model_variable_id, synonyms FROM model_mappings WHERE is_active = true ORDER BY business_term`
  );
  const lines = ["business_term,model_variable_id,synonyms"];
  for (const row of rows.rows) {
    const syn = (row.synonyms || []).join(";");
    lines.push([row.business_term, row.model_variable_id, syn].map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","));
  }
  return lines.join("\n");
}
