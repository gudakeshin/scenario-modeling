"use client";

import { useState } from "react";
import type { PeriodResult } from "@/lib/api";
import { PanelHeader } from "./PanelHeader";
import { METRIC_LABELS } from "@/lib/metrics";

interface PeriodBreakdownViewProps {
  periods: PeriodResult[];
  granularity: "monthly" | "quarterly";
  totalPl: Record<string, number>;
  onClose: () => void;
  onMinimize?: () => void;
}

function fmtNum(n: number) {
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

type ViewMode = "table" | "chart";

export function PeriodBreakdownView({ periods, granularity, totalPl, onClose, onMinimize }: PeriodBreakdownViewProps) {
  const [viewMode, setViewMode] = useState<ViewMode>("chart");
  const [selectedMetric, setSelectedMetric] = useState("net_income");

  if (!periods || periods.length === 0) return null;

  const metricKeys = Object.keys(periods[0].pl);

  // Get the max value for chart scaling
  const selectedValues = periods.map((p) => p.pl[selectedMetric] || 0);
  const maxVal = Math.max(...selectedValues.map(Math.abs), 1);

  return (
    <div className="border border-[var(--panel-border)] rounded-2xl bg-[var(--card-bg)] p-4 mx-4 mb-3 overflow-auto max-h-[60vh] shadow-panel">
      {/* Header */}
      <PanelHeader
        title={<>Period Breakdown <span className="ml-1.5 text-[10px] font-normal text-[var(--text-faint)] uppercase tracking-wider">{periods.length} {granularity} periods</span></>}
        icon={<div className="w-5 h-5 rounded-md bg-accent/10 flex items-center justify-center"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2.5"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18M9 3v18" /></svg></div>}
        onClose={onClose}
        onMinimize={onMinimize || onClose}
        isMinimized={false}
        actions={
          <div className="flex rounded-lg border border-[var(--border)] overflow-hidden">
            <button
              type="button"
              onClick={() => setViewMode("chart")}
              className={`text-[10px] px-2.5 py-1 transition-colors ${
                viewMode === "chart" ? "bg-accent text-white" : "text-[var(--text-muted)] hover:bg-[var(--panel-bg)]"
              }`}
            >
              Chart
            </button>
            <button
              type="button"
              onClick={() => setViewMode("table")}
              className={`text-[10px] px-2.5 py-1 transition-colors ${
                viewMode === "table" ? "bg-accent text-white" : "text-[var(--text-muted)] hover:bg-[var(--panel-bg)]"
              }`}
            >
              Table
            </button>
          </div>
        }
      />

      {/* Totals summary row */}
      <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 mb-4">
        {metricKeys.filter((k) => ["revenue", "cogs", "gross_margin", "opex", "ebitda", "net_income"].includes(k)).map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => setSelectedMetric(key)}
            className={`rounded-xl border p-2.5 text-center transition-all cursor-pointer ${
              selectedMetric === key
                ? "border-accent bg-accent/5 shadow-sm"
                : "border-[var(--card-border)] bg-[var(--panel-bg)] hover:border-accent/30"
            }`}
          >
            <p className="text-[9px] text-[var(--text-faint)] uppercase font-medium tracking-wider">{METRIC_LABELS[key] || key}</p>
            <p className="text-sm font-semibold text-[var(--text-primary)] mt-0.5">${fmtNum(totalPl[key] || 0)}</p>
          </button>
        ))}
      </div>

      {viewMode === "chart" ? (
        /* Bar chart view */
        <div className="space-y-1.5">
          <p className="text-[10px] text-[var(--text-faint)] uppercase tracking-wider font-medium mb-2">
            {METRIC_LABELS[selectedMetric] || selectedMetric} by period
          </p>
          {periods.map((p) => {
            const val = p.pl[selectedMetric] || 0;
            const width = Math.max(Math.abs(val) / maxVal * 100, 2);
            const isNeg = val < 0;
            return (
              <div key={p.period} className="flex items-center gap-2 group">
                <span className="text-[10px] text-[var(--text-faint)] w-14 text-right shrink-0 font-mono">{p.period}</span>
                <div className="flex-1 h-6 bg-[var(--panel-bg)] rounded-md overflow-hidden relative">
                  <div
                    className={`h-full rounded-md transition-all group-hover:opacity-90 ${
                      isNeg ? "bg-[var(--danger)]/40" : "bg-accent/40"
                    }`}
                    style={{ width: `${width}%` }}
                  />
                  <span className="absolute inset-y-0 flex items-center px-2 text-[10px] font-medium text-[var(--text-primary)]">
                    ${fmtNum(val)}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        /* Table view */
        <div className="overflow-x-auto rounded-xl border border-[var(--card-border)]">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="bg-[var(--panel-bg)]">
                <th className="text-left py-2.5 px-3 font-medium text-[var(--text-secondary)] sticky left-0 bg-[var(--panel-bg)]">Metric</th>
                {periods.map((p) => (
                  <th key={p.period} className="text-right py-2.5 px-2 font-medium text-[var(--text-secondary)] min-w-[80px]">{p.period}</th>
                ))}
                <th className="text-right py-2.5 px-3 font-semibold text-accent min-w-[90px]">Total</th>
              </tr>
            </thead>
            <tbody>
              {metricKeys.map((key) => {
                let total = 0;
                return (
                  <tr key={key} className="border-t border-[var(--border-light)] hover:bg-[var(--panel-bg)] transition-colors">
                    <td className="py-2 px-3 font-medium text-[var(--text-primary)] sticky left-0 bg-[var(--card-bg)]">
                      {METRIC_LABELS[key] || key}
                    </td>
                    {periods.map((p) => {
                      const val = p.pl[key] || 0;
                      total += val;
                      return (
                        <td key={p.period} className="text-right py-2 px-2 text-[var(--text-secondary)] tabular-nums">
                          ${fmtNum(val)}
                        </td>
                      );
                    })}
                    <td className="text-right py-2 px-3 font-semibold text-[var(--text-primary)] tabular-nums">
                      ${fmtNum(Math.round(total * 100) / 100)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Period-over-period trend */}
      {periods.length > 1 && (
        <div className="mt-3 pt-3 border-t border-[var(--border-light)]">
          <p className="text-[10px] text-[var(--text-faint)] uppercase tracking-wider font-medium mb-1.5">
            {METRIC_LABELS[selectedMetric] || selectedMetric} trend
          </p>
          <div className="flex items-end gap-1 h-16">
            {periods.map((p, i) => {
              const val = p.pl[selectedMetric] || 0;
              const prev = i > 0 ? (periods[i - 1].pl[selectedMetric] || 0) : val;
              const change = i > 0 && prev !== 0 ? ((val - prev) / Math.abs(prev)) * 100 : 0;
              const barH = Math.max((Math.abs(val) / maxVal) * 100, 8);
              return (
                <div key={p.period} className="flex-1 flex flex-col items-center gap-0.5">
                  <span className={`text-[8px] font-medium ${change >= 0 ? "text-[var(--success)]" : "text-[var(--danger)]"}`}>
                    {i > 0 ? `${change >= 0 ? "+" : ""}${change.toFixed(1)}%` : ""}
                  </span>
                  <div
                    className={`w-full rounded-t-md transition-all ${val >= 0 ? "bg-accent/50" : "bg-[var(--danger)]/40"}`}
                    style={{ height: `${barH}%` }}
                  />
                  <span className="text-[8px] text-[var(--text-faint)]">{p.period.replace(/^\d{4}-/, "")}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
