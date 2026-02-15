import pg from "pg";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function migrate() {
  const connectionString =
    process.env.DATABASE_URL ||
    "postgresql://postgres:postgres@localhost:5432/scenario_modeling";
  const client = new pg.Client({ connectionString });
  try {
    await client.connect();
    const sql = readFileSync(
      join(__dirname, "schema.sql"),
      "utf-8"
    );
    await client.query(sql);
    console.log("Schema applied successfully.");
  } finally {
    await client.end();
  }
}

migrate().catch((e) => {
  console.error(e);
  process.exit(1);
});
