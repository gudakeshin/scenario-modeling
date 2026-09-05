import { SignJWT, jwtVerify } from "jose";
import puppeteer from "puppeteer";
import { config } from "../config.js";
import { pool } from "../db/index.js";

const secret = new TextEncoder().encode(config.JWT_SECRET);

export async function createBoardPackToken(scenarioId: string, userId: string): Promise<string> {
  return new SignJWT({ scenario_id: scenarioId, user_id: userId, purpose: "board-pack-print" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setIssuer(config.JWT_ISSUER)
    .setAudience("scenario-modeling-board-pack")
    .setExpirationTime("60s")
    .sign(secret);
}

export async function verifyBoardPackToken(
  token: string,
  scenarioId: string,
): Promise<{ userId: string }> {
  const { payload } = await jwtVerify(token, secret, {
    issuer: config.JWT_ISSUER,
    audience: "scenario-modeling-board-pack",
  });
  if (payload.purpose !== "board-pack-print" || payload.scenario_id !== scenarioId) {
    throw new Error("Invalid board-pack token");
  }
  return { userId: String(payload.user_id) };
}

export async function loadBoardPackData(scenarioId: string): Promise<Record<string, unknown>> {
  const scenario = await pool.query(
    `SELECT scenario_id, name, nl_input, workspace_id FROM scenarios WHERE scenario_id = $1`,
    [scenarioId],
  );
  if (scenario.rows.length === 0) throw new Error("Scenario not found");
  const output = await pool.query(
    `SELECT output_id, output_data, narrative_summary, created_at
     FROM scenario_outputs
     WHERE scenario_id = $1 AND output_type = 'pl'
     ORDER BY created_at DESC LIMIT 1`,
    [scenarioId],
  );
  if (output.rows.length === 0) throw new Error("Run simulation first");
  const parameters = await pool.query(
    `SELECT sp.extracted_name, sp.mapped_variable_id, sp.scenario_value, sp.status,
            u.name AS owner_name, sp.owner_user_id, sp.source_citation, sp.rationale,
            sp.effective_from, sp.review_status, sp.confidence_score
     FROM scenario_parameters sp
     LEFT JOIN users u ON u.user_id = sp.owner_user_id
     WHERE sp.scenario_id = $1 AND sp.status <> 'rejected'
     ORDER BY sp.created_at`,
    [scenarioId],
  );
  const manifest = await pool.query(
    `SELECT manifest_id, row_hash, model_hash, scenario_version_id, engine, mc, created_at
     FROM run_manifests WHERE run_id = $1`,
    [output.rows[0].output_id],
  );
  const context = scenario.rows[0].workspace_id
    ? await pool.query(
        `SELECT company_name, context_data FROM company_context
         WHERE workspace_id = $1 AND status = 'active'
         ORDER BY created_at DESC LIMIT 1`,
        [scenario.rows[0].workspace_id],
      )
    : { rows: [] };

  return {
    scenario: scenario.rows[0],
    output: output.rows[0].output_data,
    narrative: output.rows[0].narrative_summary,
    run_timestamp: output.rows[0].created_at,
    parameters: parameters.rows,
    manifest: manifest.rows[0] ?? null,
    company: context.rows[0]?.company_name ?? null,
    denomination: {
      currency: context.rows[0]?.context_data?.currency ?? "USD",
      unit:
        context.rows[0]?.context_data?.currency_unit ??
        context.rows[0]?.context_data?.canonical_unit ??
        "Million",
    },
  };
}

export async function renderBoardPackPdf(scenarioId: string, userId: string): Promise<Buffer> {
  const token = await createBoardPackToken(scenarioId, userId);
  const url =
    `${config.FRONTEND_ORIGIN}/print/board-pack/${encodeURIComponent(scenarioId)}` +
    `?token=${encodeURIComponent(token)}`;
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "networkidle0", timeout: 45_000 });
    await page.waitForSelector("[data-board-pack-ready='true']", { timeout: 10_000 });
    const bytes = await page.pdf({
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: "8mm", right: "8mm", bottom: "8mm", left: "8mm" },
    });
    return Buffer.from(bytes);
  } finally {
    await browser.close();
  }
}
