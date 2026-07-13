"use client";

import { useCallback, useEffect, useState } from "react";
import { PanelHeader } from "./PanelHeader";
import { compareActuals, type ActualsCompareRow } from "@/lib/api";
import { fmtMetric, fmtMetricSigned, metricLabel } from "@/lib/metrics";

interface ActualsCompareViewProps {
  scenarioId: string;
  onClose: () => void;
  onMinimize?: () => void;
}

function cell(metricId: string, n: number | null): string {
  return n != null && Number.isFinite(n) ? fmtMetric(metricId, n) : "—";
}

function deltaCell(metricId: string, n: number | null) {
  if (n == null || !Number.isFinite(n)) return <span className="text-[var(--text-faint)]">—</span>;
  return (
    <span className={n >= 0 ? "text-[var(--success)]" : "text-[var(--danger)]"}>
      {fmtMetricSigned(metricId, n)}
    </span>
  );
}

export function ActualsCompareView({ scenarioId, onClose, onMinimize }: ActualsCompareViewProps) {
  const [rows, setRows] = useState<ActualsCompareRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await compareActuals(scenarioId);
      setRows(data.comparison ?? []);
    } catch (e) {
      setError((e as Error).message);
    }
    setLoading(false);
  }, [scenarioId]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="border-t border-[var(--border)] bg-background p-4 max-h-[60vh] overflow-auto">
      <PanelHeader
        title="Actuals vs Budget / Forecast"
        icon={
          <div className="w-5 h-5 rounded-md bg-[var(--info-bg,rgba(0,124,176,0.12))] flex items-center justify-center">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--info)" strokeWidth="2.5">
              <path d="M3 3v18h18M7 16V8M12 16v-5M17 16V5" />
            </svg>
          </div>
        }
        onClose={onClose}
        onMinimize={onMinimize || onClose}
        isMinimized={false}
      />

      <div className="flex items-center gap-2 mb-3">
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-40"
        >
          {loading ? "Loading…" : "Refresh"}
        </button>
        <span className="text-[11px] text-[var(--text-faint)]">
          Scenario output vs workspace actual / budget / forecast lanes
        </span>
      </div>

      {error && (
        <p className="text-xs text-[var(--danger)] mb-2 bg-[var(--danger-bg)] px-3 py-1.5 rounded-lg">{error}</p>
      )}

      {!loading && rows.length === 0 && !error && (
        <p className="text-xs text-[var(--text-muted)]">
          No comparison rows. Upload actuals/budget/forecast facts or run a scenario simulation first.
        </p>
      )}

      {rows.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-[var(--border)]">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-[var(--panel-bg)] text-[var(--text-muted)] text-left">
                <th className="px-3 py-2 font-medium">Measure</th>
                <th className="px-3 py-2 font-medium text-right">Actual</th>
                <th className="px-3 py-2 font-medium text-right">Budget</th>
                <th className="px-3 py-2 font-medium text-right">Forecast</th>
                <th className="px-3 py-2 font-medium text-right">Scenario</th>
                <th className="px-3 py-2 font-medium text-right">vs Actual</th>
                <th className="px-3 py-2 font-medium text-right">vs Budget</th>
                <th className="px-3 py-2 font-medium text-right">vs Forecast</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.measure_id} className="border-t border-[var(--border)]">
                  <td className="px-3 py-1.5 font-medium text-[var(--text-primary)]">
                    {metricLabel(r.measure_id)}
                  </td>
                  <td className="px-3 py-1.5 text-right text-[var(--text-muted)]">{cell(r.measure_id, r.actual)}</td>
                  <td className="px-3 py-1.5 text-right text-[var(--text-muted)]">{cell(r.measure_id, r.budget)}</td>
                  <td className="px-3 py-1.5 text-right text-[var(--text-muted)]">{cell(r.measure_id, r.forecast)}</td>
                  <td className="px-3 py-1.5 text-right text-[var(--text-primary)]">{cell(r.measure_id, r.scenario)}</td>
                  <td className="px-3 py-1.5 text-right">{deltaCell(r.measure_id, r.vs_actual)}</td>
                  <td className="px-3 py-1.5 text-right">{deltaCell(r.measure_id, r.vs_budget)}</td>
                  <td className="px-3 py-1.5 text-right">{deltaCell(r.measure_id, r.vs_forecast)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
