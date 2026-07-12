/**
 * Portfolio dashboard — workspace-level scenario KPIs and recent activity.
 */

import { pool } from "../db/index.js";

export interface DashboardKpiTile {
  key: string;
  label: string;
  value: number | string | null;
  unit?: string;
  delta_pct?: number | null;
}

export interface DashboardScenarioCard {
  scenario_id: string;
  name: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  net_income?: number | null;
  revenue?: number | null;
  simulation_mode?: string | null;
}

export interface PortfolioDashboard {
  workspace_id: string;
  kpis: DashboardKpiTile[];
  recent_scenarios: DashboardScenarioCard[];
  status_counts: Record<string, number>;
  recent_runs: Array<{
    scenario_id: string;
    name: string | null;
    ran_at: string;
    net_income?: number | null;
  }>;
}

export async function getPortfolioDashboard(workspaceId: string): Promise<PortfolioDashboard> {
  const scenarios = await pool.query(
    `SELECT scenario_id, name, status, created_at, updated_at
     FROM scenarios
     WHERE workspace_id = $1
     ORDER BY updated_at DESC NULLS LAST, created_at DESC
     LIMIT 50`,
    [workspaceId],
  );

  const status_counts: Record<string, number> = {};
  for (const row of scenarios.rows) {
    status_counts[row.status] = (status_counts[row.status] || 0) + 1;
  }

  const ids = scenarios.rows.map((r: { scenario_id: string }) => r.scenario_id);
  const outputByScenario = new Map<
    string,
    { aggregate?: Record<string, number>; simulation_mode?: string; created_at?: string }
  >();

  if (ids.length > 0) {
    const outs = await pool.query(
      `SELECT DISTINCT ON (scenario_id) scenario_id, output_data, created_at
       FROM scenario_outputs
       WHERE scenario_id = ANY($1::uuid[]) AND output_type = 'pl'
       ORDER BY scenario_id, created_at DESC`,
      [ids],
    );
    for (const row of outs.rows) {
      const data = row.output_data as {
        aggregate?: Record<string, number>;
        simulation_mode?: string;
      };
      outputByScenario.set(row.scenario_id, {
        aggregate: data.aggregate,
        simulation_mode: data.simulation_mode,
        created_at: row.created_at,
      });
    }
  }

  const recent_scenarios: DashboardScenarioCard[] = scenarios.rows.map(
    (row: {
      scenario_id: string;
      name: string | null;
      status: string;
      created_at: string;
      updated_at: string;
    }) => {
      const out = outputByScenario.get(row.scenario_id);
      return {
        scenario_id: row.scenario_id,
        name: row.name,
        status: row.status,
        created_at: row.created_at,
        updated_at: row.updated_at,
        net_income: out?.aggregate?.net_income ?? null,
        revenue: out?.aggregate?.revenue ?? null,
        simulation_mode: out?.simulation_mode ?? null,
      };
    },
  );

  const completed = recent_scenarios.filter((s) => s.status === "completed" && s.net_income != null);
  const avgNi =
    completed.length > 0
      ? completed.reduce((s, c) => s + (c.net_income || 0), 0) / completed.length
      : null;

  const kpis: DashboardKpiTile[] = [
    { key: "scenario_count", label: "Scenarios", value: scenarios.rows.length },
    { key: "completed", label: "Completed", value: status_counts.completed || 0 },
    { key: "draft", label: "Drafts", value: status_counts.draft || 0 },
    {
      key: "avg_net_income",
      label: "Avg Net Income (completed)",
      value: avgNi != null ? Math.round(avgNi * 100) / 100 : null,
      unit: "canonical",
    },
  ];

  const recent_runs = recent_scenarios
    .filter((s) => s.status === "completed")
    .slice(0, 10)
    .map((s) => ({
      scenario_id: s.scenario_id,
      name: s.name,
      ran_at: s.updated_at,
      net_income: s.net_income,
    }));

  return {
    workspace_id: workspaceId,
    kpis,
    recent_scenarios,
    status_counts,
    recent_runs,
  };
}
