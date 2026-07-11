/**
 * Dev-only seed: creates local admin and demo model mappings.
 * Never run in production.
 *
 * Usage: npx tsx scripts/seed-dev.ts
 */
import "dotenv/config";
import * as argon2 from "argon2";
import pg from "pg";

const connectionString =
  process.env.DATABASE_URL ||
  "postgresql://postgres:postgres@localhost:5432/scenario_modeling";

async function main() {
  if (process.env.NODE_ENV === "production") {
    console.error("Refusing to seed in production");
    process.exit(1);
  }

  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const password = process.env.SEED_ADMIN_PASSWORD || "changeme-admin-password";
    const hash = await argon2.hash(password, { type: argon2.argon2id });

    await client.query(
      `INSERT INTO users (email, name, role, password_hash, is_active)
       VALUES ('dev@example.com', 'Dev User', 'admin', $1, TRUE)
       ON CONFLICT (email) DO UPDATE
         SET password_hash = EXCLUDED.password_hash,
             role = 'admin',
             is_active = TRUE`,
      [hash]
    );
    console.log("Seeded admin user: dev@example.com / (SEED_ADMIN_PASSWORD or changeme-admin-password)");

    await client.query(
      `INSERT INTO model_mappings (business_term, model_variable_id, synonyms) VALUES
        ('raw materials', 'raw_material_cost', ARRAY['raw mats', 'raw_material_cost', 'raw materials increase', 'raw_materials']),
        ('revenue', 'revenue', ARRAY['sales']),
        ('opex', 'opex', ARRAY['sg&a', 'sga', 'marketing', 'operating expense']),
        ('geo_apac', 'units_sold', ARRAY['apac', 'asia pacific']),
        ('Launch or timeline delay', 'units_sold', ARRAY['delay', 'timeline shift'])
       ON CONFLICT (business_term, model_variable_id) DO UPDATE
         SET synonyms = EXCLUDED.synonyms, updated_at = NOW()`
    );
    console.log("Seeded demo model_mappings");
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
