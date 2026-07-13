"use client";

import { useState, useMemo } from "react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from "recharts";
import type { PeriodResult } from "@/lib/api";
import { PanelHeader } from "./PanelHeader";
import { METRIC_LABELS, fmtMetric, getCurrencySymbol } from "@/lib/metrics";
import { formatCompactCurrency } from "@/lib/chartTheme";

interface PeriodBreakdownViewProps {
  periods: PeriodResult[];
  granularity: "monthly" | "quarterly";
  totalPl: Record<string, number>;
  onClose: () => void;
  onMinimize?: () => void;
}

function fmt(metricId: string, n: number) {
  const s = fmtMetric(metricId, Math.abs(n));
  return n < 0 ? `-${s.replace(/^-/, "")}` : s;
}

type ViewMode = "table" | "chart";

export function PeriodBreakdownView({ periods, granularity, totalPl, onClose, onMinimize }: PeriodBreakdownViewProps) {
  const [viewMode, setViewMode] = useState<ViewMode>("chart");
  const [selectedMetric, setSelectedMetric] = useState("net_income");

  const metricKeys = periods && periods.length > 0 ? Object.keys(periods[0].pl) : [];

  const chartData = useMemo(
    () => (periods ?? []).map((p) => ({ period: p.period, value: p.pl[selectedMetric] || 0 })),
    [periods, selectedMetric],
  );

  const trendData = useMemo(
    () =>
      (periods ?? []).map((p, i) => {
        const val = p.pl[selectedMetric] || 0;
        const prev = i > 0 ? (periods[i - 1].pl[selectedMetric] || 0) : val;
        const changePct = i > 0 && prev !== 0 ? ((val - prev) / Math.abs(prev)) * 100 : null;
        return { period: p.period.replace(/^\d{4}-/, ""), value: val, changePct };
      }),
    [periods, selectedMetric],
  );

  if (!periods || periods.length === 0) return null;

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
            <p className="text-sm font-semibold text-[var(--text-primary)] mt-0.5">{fmt(key, totalPl[key] || 0)}</p>
          </button>
        ))}
      </div>

      {viewMode === "chart" ? (
        /* Bar chart view */
        <div>
          <p className="text-[10px] text-[var(--text-faint)] uppercase tracking-wider font-medium mb-2">
            {METRIC_LABELS[selectedMetric] || selectedMetric} by period
          </p>
          <div style={{ height: Math.max(periods.length * 32 + 20, 100) }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} layout="vertical" margin={{ left: 8, right: 16 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border-light)" horizontal={false} />
                <XAxis
                  type="number"
                  tickFormatter={(v: number) => formatCompactCurrency(v, getCurrencySymbol())}
                  tick={{ fontSize: 10, fill: "var(--text-faint)" }}
                  axisLine={{ stroke: "var(--border)" }}
                  tickLine={false}
                />
                <YAxis
                  type="category"
                  dataKey="period"
                  width={64}
                  tick={{ fontSize: 10, fill: "var(--text-faint)", fontFamily: "var(--font-geist-mono)" }}
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip
                  formatter={(v) => fmt(selectedMetric, Number(v))}
                  contentStyle={{ background: "var(--card-bg)", border: "1px solid var(--card-border)", borderRadius: 8, fontSize: 12 }}
                />
                <Bar dataKey="value" radius={[0, 3, 3, 0]}>
                  {chartData.map((d, i) => (
                    <Cell key={i} fill={d.value < 0 ? "var(--danger)" : "var(--accent)"} fillOpacity={0.6} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
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
                          {fmt(key, val)}
                        </td>
                      );
                    })}
                    <td className="text-right py-2 px-3 font-semibold text-[var(--text-primary)] tabular-nums">
                      {fmt(key, Math.round(total * 100) / 100)}
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
          <div className="h-24">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={trendData} barCategoryGap="20%">
                <XAxis
                  dataKey="period"
                  tick={{ fontSize: 9, fill: "var(--text-faint)" }}
                  axisLine={{ stroke: "var(--border)" }}
                  tickLine={false}
                />
                <YAxis hide />
                <Tooltip
                  formatter={(v, _name, item) => {
                    const changePct = (item?.payload as { changePct: number | null } | undefined)?.changePct;
                    const val = Number(v);
                    return [`${fmt(selectedMetric, val)}${changePct != null ? ` (${changePct >= 0 ? "+" : ""}${changePct.toFixed(1)}%)` : ""}`, METRIC_LABELS[selectedMetric] || selectedMetric];
                  }}
                  contentStyle={{ background: "var(--card-bg)", border: "1px solid var(--card-border)", borderRadius: 8, fontSize: 12 }}
                />
                <Bar dataKey="value" radius={[3, 3, 0, 0]}>
                  {trendData.map((d, i) => (
                    <Cell key={i} fill={d.value < 0 ? "var(--danger)" : "var(--accent)"} fillOpacity={0.55} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </div>
  );
}
