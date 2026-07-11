"use client";

import { useState, useCallback, useEffect, useMemo } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";
import { runSensitivity, getActiveModel, type SensitivityResult, type TornadoBar } from "@/lib/api";
import { PanelHeader } from "./PanelHeader";
import { ChartDataTable } from "./ChartDataTable";
import { fmtCurrency, fmtCurrencySigned, getCurrencySymbol } from "@/lib/metrics";
import { formatCompactCurrency } from "@/lib/chartTheme";

interface TornadoChartProps {
  scenarioId: string;
  onClose: () => void;
  onMinimize?: () => void;
}

function labelFromId(id: string): string {
  return id.split("_").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

interface TornadoDatum {
  name: string;
  downside: number;
  upside: number;
  spread: number;
  base_value: number;
  absolute_step?: boolean;
}

function TornadoTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: TornadoDatum }> }) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="bg-[var(--card-bg)] border border-[var(--card-border)] rounded-lg shadow-panel px-3 py-2">
      <p className="text-xs font-semibold text-[var(--text-primary)]">{d.name}</p>
      <p className="text-[11px] text-[var(--danger)]">Downside: {fmtCurrencySigned(d.downside)}</p>
      <p className="text-[11px]" style={{ color: "var(--chart-positive)" }}>
        Upside: {fmtCurrencySigned(d.upside)}
      </p>
      <p className="text-[11px] text-[var(--text-secondary)] mt-1">
        Spread: {fmtCurrency(d.spread)} ({d.base_value !== 0 ? ((d.spread / Math.abs(d.base_value)) * 100).toFixed(1) : 0}% of base)
      </p>
      {d.absolute_step && (
        <p className="text-[10px] text-[var(--text-faint)] italic mt-0.5">Zero-baseline input — absolute step used</p>
      )}
    </div>
  );
}

export function TornadoChart({ scenarioId, onClose, onMinimize }: TornadoChartProps) {
  const [result, setResult] = useState<SensitivityResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [targetMetric, setTargetMetric] = useState("net_income");
  const [swingPct, setSwingPct] = useState(20);
  const [metricOptions, setMetricOptions] = useState<{ value: string; label: string }[]>([]);

  useEffect(() => {
    getActiveModel().then(({ model }) => {
      if (model) {
        const opts = model.model_definition.variables
          .filter((v) => v.tags?.includes("pl_metric") || v.tags?.includes("output"))
          .map((v) => ({ value: v.id, label: v.name || labelFromId(v.id) }));
        if (opts.length > 0) {
          setMetricOptions(opts);
          if (!opts.find((o) => o.value === targetMetric) && opts[0]) {
            setTargetMetric(opts[0].value);
          }
        }
      }
      if (metricOptions.length === 0) {
        setMetricOptions([{ value: "net_income", label: "Net Income" }]);
      }
    }).catch(() => {
      setMetricOptions([{ value: "net_income", label: "Net Income" }]);
    });
  }, []);

  const run = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await runSensitivity(scenarioId, targetMetric, swingPct);
      setResult(data);
    } catch (e) {
      setError((e as Error).message);
    }
    setLoading(false);
  }, [scenarioId, targetMetric, swingPct]);

  const chartData: TornadoDatum[] = useMemo(
    () =>
      (result?.bars ?? []).map((b: TornadoBar) => ({
        name: b.variable_name,
        downside: Math.min(b.low_delta, b.high_delta),
        upside: Math.max(b.low_delta, b.high_delta),
        spread: b.spread,
        base_value: b.base_value,
        absolute_step: b.absolute_step,
      })),
    [result],
  );
  const chartHeight = Math.max(chartData.length * 36 + 40, 120);

  return (
    <div className="border-t border-[var(--border)] bg-background p-4 max-h-[60vh] overflow-auto">
      <PanelHeader
        title="Sensitivity Analysis (Tornado Chart)"
        icon={<div className="w-5 h-5 rounded-md bg-[var(--warning-bg)] flex items-center justify-center"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--warning)" strokeWidth="2.5"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" /></svg></div>}
        onClose={onClose}
        onMinimize={onMinimize || onClose}
        isMinimized={false}
      />

      {/* Config */}
      <div className="flex items-center gap-3 mb-4 flex-wrap bg-[var(--panel-bg)] rounded-xl border border-[var(--panel-border)] p-3">
        <label className="text-xs text-[var(--text-muted)]">
          Target:
          <select
            value={targetMetric}
            onChange={(e) => setTargetMetric(e.target.value)}
            className="ml-1.5 rounded-lg border border-[var(--input-border)] bg-[var(--card-bg)] px-2 py-1 text-xs focus:outline-none focus:border-[var(--input-focus-border)]"
          >
            {metricOptions.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
        <label className="text-xs text-[var(--text-muted)]">
          Swing:
          <input
            type="number"
            min={5}
            max={50}
            step={5}
            value={swingPct}
            onChange={(e) => setSwingPct(Number(e.target.value))}
            className="ml-1.5 w-14 rounded-lg border border-[var(--input-border)] bg-[var(--card-bg)] px-2 py-1 text-xs focus:outline-none focus:border-[var(--input-focus-border)]"
          />
          %
        </label>
        <button
          onClick={run}
          disabled={loading}
          className="rounded-lg bg-accent px-4 py-1.5 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-40 shadow-sm transition-colors"
        >
          {loading ? "Analyzing..." : "Run Analysis"}
        </button>
      </div>

      {error && <p className="text-xs text-[var(--danger)] mb-2 bg-[var(--danger-bg)] px-3 py-1.5 rounded-lg">{error}</p>}

      {result && (
        <>
          <p className="text-xs text-[var(--text-faint)] mb-3">
            Base {metricOptions.find((o) => o.value === result.target_metric)?.label || labelFromId(result.target_metric)}: {fmtCurrency(result.base_metric_value)} | ±{result.swing_pct}% swing
          </p>

          {result.bars.length === 0 ? (
            <p className="text-xs text-[var(--text-faint)]">No input variables found to analyze.</p>
          ) : (
            <div style={{ height: chartHeight }}>
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
                    dataKey="name"
                    width={110}
                    tick={{ fontSize: 11, fill: "var(--text-primary)" }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <Tooltip content={<TornadoTooltip />} />
                  <ReferenceLine x={0} stroke="var(--border)" strokeWidth={1.5} />
                  <Bar dataKey="downside" stackId="tornado" fill="var(--danger)" radius={[3, 0, 0, 3]} />
                  <Bar dataKey="upside" stackId="tornado" fill="var(--chart-positive)" radius={[0, 3, 3, 0]} />
                </BarChart>
              </ResponsiveContainer>
              <ChartDataTable
                caption={`Sensitivity tornado for ${metricOptions.find((o) => o.value === result.target_metric)?.label || labelFromId(result.target_metric)}`}
                columns={["Variable", "Downside", "Upside", "Spread"]}
                rows={chartData.map((d) => [d.name, d.downside, d.upside, d.spread])}
              />
            </div>
          )}

          {/* Impact ranking */}
          {result.bars.length > 0 && (
            <div className="mt-4 p-3.5 rounded-xl bg-[var(--panel-bg)] border border-[var(--panel-border)]">
              <h4 className="text-xs font-semibold mb-1.5 text-[var(--text-primary)]">Variable Impact Ranking</h4>
              <ol className="list-decimal list-inside text-xs text-[var(--text-secondary)] space-y-0.5">
                {result.bars.map((b) => (
                  <li key={b.variable_id}>
                    <strong className="text-[var(--text-primary)]">{b.variable_name}</strong> &mdash; spread of {fmtCurrency(b.spread)} ({((b.spread / result.base_metric_value) * 100).toFixed(1)}% of base)
                  </li>
                ))}
              </ol>
            </div>
          )}
        </>
      )}
    </div>
  );
}
