"use client";

import { useMemo, useState } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
  Area,
  AreaChart,
} from "recharts";
import type { PeriodResult } from "@/lib/api";
import { METRIC_LABELS, METRIC_COLORS, fmtCurrency, getCurrencySymbol } from "@/lib/metrics";

interface TrendLineChartProps {
  periods: PeriodResult[];
  granularity: "monthly" | "quarterly";
}

function fmt(n: number) {
  return fmtCurrency(n);
}

type ChartMode = "line" | "area";

export function TrendLineChart({ periods, granularity: _granularity }: TrendLineChartProps) {
  void _granularity; // retained for future use (axis label formatting)
  const [selectedMetrics, setSelectedMetrics] = useState<Set<string>>(new Set(["revenue", "net_income", "ebitda"]));
  const [chartMode, setChartMode] = useState<ChartMode>("line");

  const allMetrics = useMemo(() => {
    if (!periods.length) return [];
    return Object.keys(periods[0].pl);
  }, [periods]);

  const chartData = useMemo(() => {
    return periods.map((p) => ({
      period: p.period.replace(/^\d{4}-/, ""),
      fullPeriod: p.period,
      ...p.pl,
    }));
  }, [periods]);

  const toggleMetric = (metric: string) => {
    setSelectedMetrics((prev) => {
      const next = new Set(prev);
      if (next.has(metric)) {
        if (next.size > 1) next.delete(metric); // keep at least one
      } else {
        next.add(metric);
      }
      return next;
    });
  };

  const CustomTooltip = ({ active, payload, label }: { active?: boolean; payload?: Array<{ dataKey: string; value: number; color: string }>; label?: string }) => {
    if (!active || !payload?.length) return null;
    return (
      <div className="bg-[var(--card-bg)] border border-[var(--card-border)] rounded-lg shadow-panel px-3 py-2.5 min-w-[140px]">
        <p className="text-[10px] font-medium text-[var(--text-faint)] uppercase tracking-wider mb-1.5">{label}</p>
        {payload.map((entry) => (
          <div key={entry.dataKey} className="flex items-center justify-between gap-3 text-xs">
            <div className="flex items-center gap-1.5">
              <div className="w-2 h-2 rounded-full" style={{ backgroundColor: entry.color }} />
              <span className="text-[var(--text-secondary)]">{METRIC_LABELS[entry.dataKey] || entry.dataKey}</span>
            </div>
            <span className="font-medium text-[var(--text-primary)]">{fmt(entry.value)}</span>
          </div>
        ))}
      </div>
    );
  };

  const activeMetrics = allMetrics.filter((m) => selectedMetrics.has(m));

  return (
    <div>
      {/* Metric toggles */}
      <div className="flex flex-wrap items-center gap-1.5 mb-3">
        {allMetrics.map((metric) => (
          <button
            key={metric}
            type="button"
            onClick={() => toggleMetric(metric)}
            className={`text-[10px] px-2.5 py-1 rounded-full border transition-all ${
              selectedMetrics.has(metric)
                ? "border-transparent text-white shadow-sm"
                : "border-[var(--border)] text-[var(--text-muted)] hover:bg-[var(--panel-bg)]"
            }`}
            style={selectedMetrics.has(metric) ? { backgroundColor: METRIC_COLORS[metric] || "#97999B" } : {}}
          >
            {METRIC_LABELS[metric] || metric}
          </button>
        ))}
        <div className="ml-auto flex rounded-lg border border-[var(--border)] overflow-hidden">
          <button
            type="button"
            onClick={() => setChartMode("line")}
            className={`text-[10px] px-2 py-0.5 transition-colors ${chartMode === "line" ? "bg-accent text-white" : "text-[var(--text-muted)]"}`}
          >
            Line
          </button>
          <button
            type="button"
            onClick={() => setChartMode("area")}
            className={`text-[10px] px-2 py-0.5 transition-colors ${chartMode === "area" ? "bg-accent text-white" : "text-[var(--text-muted)]"}`}
          >
            Area
          </button>
        </div>
      </div>

      {/* Chart */}
      <div className="h-56">
        <ResponsiveContainer width="100%" height="100%">
          {chartMode === "line" ? (
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border-light)" />
              <XAxis
                dataKey="period"
                tick={{ fontSize: 10, fill: "var(--text-faint)" }}
                axisLine={{ stroke: "var(--border)" }}
                tickLine={false}
              />
              <YAxis
                tick={{ fontSize: 10, fill: "var(--text-faint)" }}
                tickFormatter={(v: number) => `${getCurrencySymbol()}${(v / 1000).toFixed(0)}k`}
                axisLine={false}
                tickLine={false}
              />
              <Tooltip content={<CustomTooltip />} />
              <Legend
                formatter={(value: string) => (
                  <span className="text-[10px] text-[var(--text-secondary)]">{METRIC_LABELS[value] || value}</span>
                )}
                iconType="circle"
                iconSize={6}
              />
              {activeMetrics.map((metric) => (
                <Line
                  key={metric}
                  type="monotone"
                  dataKey={metric}
                  stroke={METRIC_COLORS[metric] || "#97999B"}
                  strokeWidth={2}
                  dot={{ r: 4, fill: METRIC_COLORS[metric] || "#97999B" }}
                  activeDot={{ r: 6 }}
                />
              ))}
            </LineChart>
          ) : (
            <AreaChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border-light)" />
              <XAxis
                dataKey="period"
                tick={{ fontSize: 10, fill: "var(--text-faint)" }}
                axisLine={{ stroke: "var(--border)" }}
                tickLine={false}
              />
              <YAxis
                tick={{ fontSize: 10, fill: "var(--text-faint)" }}
                tickFormatter={(v: number) => `${getCurrencySymbol()}${(v / 1000).toFixed(0)}k`}
                axisLine={false}
                tickLine={false}
              />
              <Tooltip content={<CustomTooltip />} />
              <Legend
                formatter={(value: string) => (
                  <span className="text-[10px] text-[var(--text-secondary)]">{METRIC_LABELS[value] || value}</span>
                )}
                iconType="circle"
                iconSize={6}
              />
              {activeMetrics.map((metric) => (
                <Area
                  key={metric}
                  type="monotone"
                  dataKey={metric}
                  stroke={METRIC_COLORS[metric] || "#97999B"}
                  fill={METRIC_COLORS[metric] || "#97999B"}
                  fillOpacity={0.15}
                  strokeWidth={2}
                />
              ))}
            </AreaChart>
          )}
        </ResponsiveContainer>
      </div>
    </div>
  );
}
