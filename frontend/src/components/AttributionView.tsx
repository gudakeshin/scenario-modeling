"use client";

import { useState, useCallback, useMemo, useEffect } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
  ReferenceLine,
} from "recharts";
import { PanelHeader } from "./PanelHeader";
import { ChartDataTable } from "./ChartDataTable";
import { runAttribution, getActiveModel, type AttributionResult } from "@/lib/api";
import { fmtCurrency, fmtCurrencySigned, getCurrencySymbol, pickDefaultTargetMetric, metricLabel, useCurrencyVersion } from "@/lib/metrics";
import { formatCompactCurrency } from "@/lib/chartTheme";

interface AttributionViewProps {
  scenarioId: string;
  onClose: () => void;
  onMinimize?: () => void;
}

export function AttributionView({ scenarioId, onClose, onMinimize }: AttributionViewProps) {
  useCurrencyVersion();
  const [result, setResult] = useState<AttributionResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [targetMetric, setTargetMetric] = useState("");
  const [metricOptions, setMetricOptions] = useState<string[]>([]);
  const [reason, setReason] = useState(false);

  useEffect(() => {
    getActiveModel()
      .then(({ model }) => {
        const ids = (model?.model_definition?.variables ?? [])
          .filter((v) => v.tags?.includes("pl_metric") || v.tags?.includes("output") || (v.dependencies?.length ?? 0) > 0)
          .map((v) => v.id);
        setMetricOptions(ids);
        setTargetMetric(pickDefaultTargetMetric(ids, "net_income"));
      })
      .catch(() => setTargetMetric("ebitda"));
  }, []);

  const run = useCallback(async () => {
    if (!targetMetric) return;
    setLoading(true);
    setError(null);
    try {
      setResult(await runAttribution(scenarioId, targetMetric, { reason }));
    } catch (e) {
      setError((e as Error).message);
    }
    setLoading(false);
  }, [scenarioId, targetMetric, reason]);

  const chartData = useMemo(() => {
    if (!result) return [];
    let running = result.base_value;
    return result.bars.map((b) => {
      const start = running;
      running += b.contribution;
      return {
        name: b.variable_name,
        contribution: b.contribution,
        start: Math.min(start, start + b.contribution),
        span: Math.abs(b.contribution),
        fill: b.residual
          ? "var(--text-faint)"
          : b.contribution >= 0
            ? "var(--chart-positive)"
            : "var(--danger)",
        residual: b.residual,
      };
    });
  }, [result]);

  return (
    <div className="border-t border-[var(--border)] bg-background p-4 max-h-[60vh] overflow-auto">
      <PanelHeader
        title="Driver Attribution"
        icon={
          <div className="w-5 h-5 rounded-md bg-[var(--success-bg)] flex items-center justify-center">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--success)" strokeWidth="2.5">
              <path d="M3 3v18h18M7 14l4-4 3 3 5-6" />
            </svg>
          </div>
        }
        onClose={onClose}
        onMinimize={onMinimize || onClose}
        isMinimized={false}
      />

      <div className="flex items-center gap-3 mb-4 bg-[var(--panel-bg)] rounded-xl border border-[var(--panel-border)] p-3">
        <label className="text-xs text-[var(--text-muted)]">
          Metric:
          {metricOptions.length > 0 ? (
            <select
              value={targetMetric}
              onChange={(e) => setTargetMetric(e.target.value)}
              className="ml-1.5 w-40 rounded-lg border border-[var(--input-border)] bg-[var(--card-bg)] px-2 py-1 text-xs"
            >
              {metricOptions.map((id) => (
                <option key={id} value={id}>{metricLabel(id)}</option>
              ))}
            </select>
          ) : (
            <input
              value={targetMetric}
              onChange={(e) => setTargetMetric(e.target.value)}
              className="ml-1.5 w-32 rounded-lg border border-[var(--input-border)] bg-[var(--card-bg)] px-2 py-1 text-xs"
            />
          )}
        </label>
        <button
          type="button"
          onClick={run}
          disabled={loading}
          className="rounded-lg bg-accent px-4 py-1.5 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-40"
        >
          {loading ? "Running..." : "Run Attribution"}
        </button>
        <label className="text-xs text-[var(--text-muted)] flex items-center gap-1.5 ml-auto">
          <input
            type="checkbox"
            checked={reason}
            onChange={(e) => setReason(e.target.checked)}
          />
          Add rationale
        </label>
      </div>

      {error && <p className="text-xs text-[var(--danger)] mb-2 bg-[var(--danger-bg)] px-3 py-1.5 rounded-lg">{error}</p>}

      {result && (
        <>
          <p className="text-xs text-[var(--text-faint)] mb-2">
            Δ {fmtCurrencySigned(result.total_delta)} · {result.method.replace("_", " ")} · base{" "}
            {fmtCurrency(result.base_value)} → scenario {fmtCurrency(result.scenario_value)}
          </p>
          {result.rationale && (
            <p className="text-xs text-[var(--text-secondary)] mb-2 italic">{result.rationale}</p>
          )}
          {result.driver_groups && result.driver_groups.length > 0 && (
            <div className="mb-2 space-y-1">
              {result.driver_groups.map((g) => (
                <p key={g.category} className="text-[11px] text-[var(--text-muted)]">
                  <span className="font-medium text-[var(--text-secondary)]">{g.category}:</span>{" "}
                  {g.variable_ids.join(", ")}
                  {g.rationale ? ` — ${g.rationale}` : ""}
                </p>
              ))}
            </div>
          )}
          {result.notices?.map((n, i) => (
            <p key={i} className="text-[11px] text-[var(--warning)] bg-[var(--warning-bg)] px-2.5 py-1 rounded-lg mb-1">
              {n}
            </p>
          ))}
          <div style={{ height: Math.max(chartData.length * 36 + 40, 120) }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} layout="vertical" margin={{ left: 8, right: 16 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border-light)" horizontal={false} />
                <XAxis
                  type="number"
                  tickFormatter={(v: number) => formatCompactCurrency(v, getCurrencySymbol())}
                  tick={{ fontSize: 10, fill: "var(--text-faint)" }}
                />
                <YAxis type="category" dataKey="name" width={100} tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
                <Tooltip
                  formatter={(v) => fmtCurrencySigned(Number(v ?? 0))}
                  contentStyle={{ background: "var(--card-bg)", border: "1px solid var(--card-border)" }}
                />
                <ReferenceLine x={0} stroke="var(--border)" />
                <Bar dataKey="contribution" radius={[3, 3, 3, 3]} barSize={18}>
                  {chartData.map((d, i) => (
                    <Cell key={i} fill={d.fill} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <ChartDataTable
            caption="Attribution contributions"
            columns={["Driver", "Contribution"]}
            rows={result.bars.map((b) => [b.variable_name, b.contribution])}
          />
        </>
      )}
    </div>
  );
}
