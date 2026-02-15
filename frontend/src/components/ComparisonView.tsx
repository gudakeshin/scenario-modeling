"use client";

import { useEffect, useState, useMemo } from "react";
import { PanelHeader } from "./PanelHeader";
import { compareScenarios as compareApi, listScenarios, type ComparisonResult } from "@/lib/api";
import { METRIC_LABELS } from "@/lib/metrics";

interface ComparisonViewProps {
  currentScenarioId: string;
  onClose: () => void;
  onMinimize?: () => void;
}

function fmtNum(n: number) {
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

function fmtDelta(n: number) {
  const sign = n >= 0 ? "+" : "";
  return sign + fmtNum(n);
}

type SortKey = "metric" | "base" | "delta" | "delta_pct";
type SortDir = "asc" | "desc";
type FilterMode = "all" | "positive" | "negative";

export function ComparisonView({ currentScenarioId, onClose, onMinimize }: ComparisonViewProps) {
  const [comparison, setComparison] = useState<ComparisonResult | null>(null);
  const [allScenarios, setAllScenarios] = useState<{ scenario_id: string; name: string | null; status: string }[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([currentScenarioId]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Sorting & filtering state
  const [sortKey, setSortKey] = useState<SortKey>("metric");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [filterMode, setFilterMode] = useState<FilterMode>("all");

  useEffect(() => {
    listScenarios().then((s) => setAllScenarios(s.filter((x) => x.status === "completed"))).catch(() => {});
  }, []);

  const handleCompare = async () => {
    if (selectedIds.length === 0) return;
    setLoading(true);
    setError(null);
    try {
      const r = await compareApi(selectedIds);
      setComparison(r);
    } catch (e) {
      setError((e as Error).message);
    }
    setLoading(false);
  };

  useEffect(() => {
    if (selectedIds.length > 0) handleCompare();
  }, []); // run on mount

  const toggleScenario = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : prev.length < 4 ? [...prev, id] : prev
    );
  };

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "metric" ? "asc" : "desc");
    }
  };

  const sortedMetrics = useMemo(() => {
    if (!comparison) return [];
    let rows = [...comparison.metrics];

    // Filter
    if (filterMode !== "all") {
      rows = rows.filter((row) => {
        const firstDelta = row.scenarios[0]?.delta ?? 0;
        return filterMode === "positive" ? firstDelta >= 0 : firstDelta < 0;
      });
    }

    // Sort
    rows.sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case "metric":
          cmp = (METRIC_LABELS[a.metric] || a.metric).localeCompare(METRIC_LABELS[b.metric] || b.metric);
          break;
        case "base":
          cmp = a.base - b.base;
          break;
        case "delta":
          cmp = (a.scenarios[0]?.delta ?? 0) - (b.scenarios[0]?.delta ?? 0);
          break;
        case "delta_pct":
          cmp = (a.scenarios[0]?.delta_pct ?? 0) - (b.scenarios[0]?.delta_pct ?? 0);
          break;
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
    return rows;
  }, [comparison, sortKey, sortDir, filterMode]);

  const sortIcon = (key: SortKey) => {
    if (sortKey !== key) return "\u2195";
    return sortDir === "asc" ? "\u2191" : "\u2193";
  };

  return (
    <div className="border border-[var(--panel-border)] rounded-2xl bg-[var(--card-bg)] p-4 mx-4 mb-3 overflow-auto max-h-[60vh] shadow-panel">
      <PanelHeader
        title="Scenario Comparison"
        icon={<div className="w-5 h-5 rounded-md bg-[var(--info-bg)] flex items-center justify-center"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--info)" strokeWidth="2.5"><path d="M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5" /></svg></div>}
        onClose={onClose}
        onMinimize={onMinimize || onClose}
        isMinimized={false}
      />
      {allScenarios.length > 1 && (
        <div className="mb-3 flex flex-wrap gap-1.5">
          {allScenarios.map((s) => (
            <button
              key={s.scenario_id}
              type="button"
              onClick={() => toggleScenario(s.scenario_id)}
              className={`text-xs px-2.5 py-1 rounded-full border transition-all ${
                selectedIds.includes(s.scenario_id)
                  ? "bg-accent text-white border-accent shadow-sm"
                  : "border-[var(--border)] text-[var(--text-muted)] hover:bg-[var(--panel-bg)] hover:border-[var(--panel-border)]"
              }`}
            >
              {s.name || s.scenario_id.slice(0, 8)}
            </button>
          ))}
          <button type="button" onClick={handleCompare} disabled={loading} className="text-xs px-3 py-1 rounded-full bg-accent text-white disabled:opacity-40 shadow-sm transition-opacity">
            {loading ? "..." : "Compare"}
          </button>
        </div>
      )}

      {error && <p className="text-xs text-[var(--danger)] mb-2 bg-[var(--danger-bg)] px-3 py-1.5 rounded-lg">{error}</p>}

      {comparison && (
        <>
          {/* Key callout cards */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
            {comparison.key_callouts.map((c) => (
              <div key={c.label} className="rounded-xl border border-[var(--card-border)] bg-[var(--panel-bg)] p-3 text-center shadow-card hover:shadow-card-hover transition-shadow">
                <p className="text-[10px] text-[var(--text-faint)] uppercase font-medium tracking-wider">{METRIC_LABELS[c.label] || c.label}</p>
                <p className="text-lg font-semibold text-[var(--text-primary)] mt-1">${fmtNum(c.scenario)}</p>
                <p className={`text-xs font-medium mt-0.5 ${c.delta >= 0 ? "text-[var(--success)]" : "text-[var(--danger)]"}`}>
                  {fmtDelta(c.delta)} {c.delta_pct != null && `(${c.delta >= 0 ? "+" : ""}${c.delta_pct}%)`}
                </p>
              </div>
            ))}
          </div>

          {/* Sort & filter controls */}
          <div className="flex items-center gap-2 mb-2">
            <span className="text-[10px] text-[var(--text-faint)] uppercase tracking-wider font-medium">Filter:</span>
            {(["all", "positive", "negative"] as FilterMode[]).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setFilterMode(mode)}
                className={`text-[10px] px-2 py-0.5 rounded-full border transition-all ${
                  filterMode === mode
                    ? "bg-accent text-white border-accent"
                    : "border-[var(--border)] text-[var(--text-muted)] hover:bg-[var(--panel-bg)]"
                }`}
              >
                {mode === "all" ? "All" : mode === "positive" ? "\u2191 Positive" : "\u2193 Negative"}
              </button>
            ))}
          </div>

          {/* Comparison table with sortable columns */}
          <div className="overflow-x-auto rounded-xl border border-[var(--card-border)]">
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="bg-[var(--panel-bg)]">
                  <th
                    className="text-left py-2.5 px-3 font-medium text-[var(--text-secondary)] cursor-pointer hover:text-[var(--text-primary)] select-none"
                    onClick={() => handleSort("metric")}
                  >
                    Metric {sortIcon("metric")}
                  </th>
                  <th
                    className="text-right py-2.5 px-2 font-medium text-[var(--text-secondary)] cursor-pointer hover:text-[var(--text-primary)] select-none"
                    onClick={() => handleSort("base")}
                  >
                    Base {sortIcon("base")}
                  </th>
                  {comparison.metrics[0]?.scenarios.map((s) => (
                    <th key={s.scenario_id} className="text-right py-2.5 px-2 font-medium text-[var(--text-secondary)]" colSpan={2}>
                      {s.name || s.scenario_id.slice(0, 8)}
                    </th>
                  ))}
                </tr>
                <tr className="border-b border-[var(--border-light)] text-[var(--text-faint)]">
                  <th />
                  <th className="text-right py-1 px-2 font-normal">Value</th>
                  {comparison.metrics[0]?.scenarios.map((s) => (
                    <>
                      <th key={s.scenario_id + "-v"} className="text-right py-1 px-2 font-normal">Value</th>
                      <th
                        key={s.scenario_id + "-d"}
                        className="text-right py-1 px-2 font-normal cursor-pointer hover:text-[var(--text-primary)] select-none"
                        onClick={() => handleSort("delta")}
                      >
                        Delta {sortIcon("delta")}
                      </th>
                    </>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sortedMetrics.map((row) => (
                  <tr key={row.metric} className="border-b border-[var(--border-light)] hover:bg-[var(--panel-bg)] transition-colors">
                    <td className="py-2 px-3 font-medium text-[var(--text-primary)]">{METRIC_LABELS[row.metric] || row.metric}</td>
                    <td className="text-right py-2 px-2 text-[var(--text-secondary)]">${fmtNum(row.base)}</td>
                    {row.scenarios.map((s) => (
                      <>
                        <td key={s.scenario_id + "-v"} className="text-right py-2 px-2 text-[var(--text-primary)]">${fmtNum(s.value)}</td>
                        <td key={s.scenario_id + "-d"} className={`text-right py-2 px-2 font-medium ${s.delta >= 0 ? "text-[var(--success)]" : "text-[var(--danger)]"}`}>
                          {fmtDelta(s.delta)}
                          {s.delta_pct != null && (
                            <span className="text-[10px] ml-0.5 opacity-60">({s.delta >= 0 ? "+" : ""}{s.delta_pct}%)</span>
                          )}
                        </td>
                      </>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Assumption diff */}
          {comparison.assumption_diff.length > 0 && (
            <div className="mt-4">
              <h4 className="font-medium text-xs mb-2 text-[var(--text-muted)]">Assumption Differences</h4>
              <div className="rounded-xl border border-[var(--card-border)] overflow-hidden">
                <table className="w-full text-xs border-collapse">
                  <thead>
                    <tr className="bg-[var(--panel-bg)]">
                      <th className="text-left py-2 px-3 font-medium text-[var(--text-secondary)]">Parameter</th>
                      {comparison.assumption_diff[0]?.scenarios.map((s) => (
                        <th key={s.scenario_id} className="text-right py-2 px-2 font-medium text-[var(--text-secondary)]">{s.name || s.scenario_id.slice(0, 8)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {comparison.assumption_diff.map((row) => (
                      <tr key={row.parameter} className="border-t border-[var(--border-light)]">
                        <td className="py-1.5 px-3 text-[var(--text-primary)]">{row.parameter}</td>
                        {row.scenarios.map((s) => (
                          <td key={s.scenario_id} className="text-right py-1.5 px-2 text-[var(--text-secondary)]">{s.value}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
