import pg from "pg";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/scenario_modeling",
});

// Default system user (configurable via env for different environments)
const DEFAULT_USER_EMAIL = process.env.DEFAULT_USER_EMAIL || "system@scenario-modeling.local";
const DEFAULT_USER_NAME = process.env.DEFAULT_USER_NAME || "System User";
const DEFAULT_USER_ROLE = process.env.DEFAULT_USER_ROLE || "analyst";

export async function getDefaultUserId(): Promise<string> {
  const r = await pool.query(
    "SELECT user_id FROM users WHERE email = $1 LIMIT 1",
    [DEFAULT_USER_EMAIL]
  );
  if (r.rows[0]) return r.rows[0].user_id;
  const ins = await pool.query(
    "INSERT INTO users (email, name, role) VALUES ($1, $2, $3) ON CONFLICT (email) DO NOTHING RETURNING user_id",
    [DEFAULT_USER_EMAIL, DEFAULT_USER_NAME, DEFAULT_USER_ROLE]
  );
  if (ins.rows[0]) return ins.rows[0].user_id;
  // If ON CONFLICT hit, re-query
  const r2 = await pool.query("SELECT user_id FROM users WHERE email = $1 LIMIT 1", [DEFAULT_USER_EMAIL]);
  return r2.rows[0].user_id;
}

/**
 * Resolve a user identifier (UUID or email) to a UUID.
 * Falls back to the default user if the identifier is not found.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export async function resolveUserId(identifier?: string): Promise<string> {
  if (!identifier) return getDefaultUserId();
  if (UUID_RE.test(identifier)) return identifier;
  // Treat as email — look up the user_id
  const r = await pool.query("SELECT user_id FROM users WHERE email = $1 LIMIT 1", [identifier]);
  if (r.rows[0]) return r.rows[0].user_id;
  return getDefaultUserId();
}

export { pool };
