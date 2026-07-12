"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getPortfolioDashboard, type PortfolioDashboard } from "@/lib/api";

export default function DashboardPage() {
  const [data, setData] = useState<PortfolioDashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const d = await getPortfolioDashboard();
        if (!cancelled) setData(d);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="min-h-screen bg-[var(--page-bg)] text-[var(--text-primary)] p-6 md:p-10">
      <div className="max-w-6xl mx-auto space-y-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Portfolio Dashboard</h1>
            <p className="text-sm text-[var(--text-muted)] mt-1">
              Cross-scenario KPIs, recent runs, and library for this workspace
            </p>
          </div>
          <Link
            href="/"
            className="text-sm px-3 py-1.5 rounded-md border border-[var(--border)] hover:bg-[var(--card-bg)]"
          >
            Open scenario chat
          </Link>
        </div>

        {loading && <p className="text-sm text-[var(--text-muted)]">Loading dashboard…</p>}
        {error && (
          <div className="text-sm text-[var(--warning)] border border-[var(--warning)]/30 rounded-lg p-3">
            {error}
          </div>
        )}

        {data && (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {data.kpis.map((k) => (
                <div
                  key={k.key}
                  className="bg-[var(--card-bg)] border border-[var(--border)] rounded-lg p-4"
                >
                  <div className="text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
                    {k.label}
                  </div>
                  <div className="text-xl font-semibold mt-1">
                    {k.value == null ? "—" : String(k.value)}
                  </div>
                </div>
              ))}
            </div>

            <div className="grid md:grid-cols-2 gap-4">
              <section className="bg-[var(--card-bg)] border border-[var(--border)] rounded-lg p-4">
                <h2 className="text-sm font-medium mb-3">Recent runs</h2>
                <ul className="space-y-2 text-sm">
                  {data.recent_runs.length === 0 && (
                    <li className="text-[var(--text-muted)]">No completed runs yet</li>
                  )}
                  {data.recent_runs.map((r) => (
                    <li key={r.scenario_id} className="flex justify-between gap-2">
                      <span className="truncate">{r.name || r.scenario_id.slice(0, 8)}</span>
                      <span className="text-[var(--text-muted)] tabular-nums">
                        NI {r.net_income ?? "—"}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>

              <section className="bg-[var(--card-bg)] border border-[var(--border)] rounded-lg p-4">
                <h2 className="text-sm font-medium mb-3">Status mix</h2>
                <ul className="space-y-2 text-sm">
                  {Object.entries(data.status_counts).map(([status, count]) => (
                    <li key={status} className="flex justify-between">
                      <span className="capitalize">{status}</span>
                      <span className="tabular-nums">{count}</span>
                    </li>
                  ))}
                </ul>
              </section>
            </div>

            <section className="bg-[var(--card-bg)] border border-[var(--border)] rounded-lg p-4 overflow-x-auto">
              <h2 className="text-sm font-medium mb-3">Scenario library</h2>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[var(--text-muted)] border-b border-[var(--border)]">
                    <th className="py-2 pr-2">Name</th>
                    <th className="py-2 pr-2">Status</th>
                    <th className="py-2 pr-2">Revenue</th>
                    <th className="py-2 pr-2">Net income</th>
                    <th className="py-2">Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {data.recent_scenarios.map((s) => (
                    <tr key={s.scenario_id} className="border-b border-[var(--border)]/60">
                      <td className="py-2 pr-2">{s.name || s.scenario_id.slice(0, 8)}</td>
                      <td className="py-2 pr-2 capitalize">{s.status}</td>
                      <td className="py-2 pr-2 tabular-nums">{s.revenue ?? "—"}</td>
                      <td className="py-2 pr-2 tabular-nums">{s.net_income ?? "—"}</td>
                      <td className="py-2 text-[var(--text-muted)]">
                        {new Date(s.updated_at).toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          </>
        )}
      </div>
    </main>
  );
}
