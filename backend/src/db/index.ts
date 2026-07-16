import pg from "pg";
import { config } from "../config.js";
import { logger } from "../logger.js";

const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  max: config.PG_POOL_MAX,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30_000,
});

pool.on("connect", (client) => {
  void client.query(`SET statement_timeout = ${config.PG_STATEMENT_TIMEOUT_MS}`);
});

pool.on("error", (err) => {
  logger.error({ err }, "Unexpected Postgres pool error");
});

/**
 * Resolve a user identifier (UUID or email) to a UUID.
 * Throws if the identifier is missing or not found — no fail-open default.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function resolveUserId(identifier: string): Promise<string> {
  if (!identifier) {
    throw Object.assign(new Error("User identity required"), { status: 401 });
  }
  if (UUID_RE.test(identifier)) return identifier;
  const r = await pool.query("SELECT user_id FROM users WHERE email = $1 LIMIT 1", [identifier]);
  if (r.rows[0]) return r.rows[0].user_id;
  throw Object.assign(new Error("User not found"), { status: 404 });
}

export { pool };
