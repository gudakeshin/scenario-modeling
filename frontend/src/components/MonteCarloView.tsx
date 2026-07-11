"use client";

import { useState, useCallback, useMemo } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  Cell,
} from "recharts";
import { PanelHeader } from "./PanelHeader";
import { ChartDataTable } from "./ChartDataTable";
import { runMonteCarlo, type MonteCarloResult, type PercentileResult } from "@/lib/api";
import { METRIC_LABELS, fmtCurrency, getCurrencySymbol } from "@/lib/metrics";
import { formatCompactCurrency } from "@/lib/chartTheme";

interface MonteCarloViewProps {
  scenarioId: string;
  onClose: () => void;
  onMinimize?: () => void;
}

function fmt(n: number) {
  return n < 0 ? `-${fmtCurrency(n)}` : fmtCurrency(n);
}

// ── Fan band: horizontal floating-bar chart, one row per metric ──
// P5-P95 (light) and P25-P75 (dark) bands around the P50 marker. There is
// no time dimension in the backend result (periods repeat the same
// evaluation — see simulationService's documented "no compounding"
// design), so this shows the distribution's spread rather than a fake
// time-series fan.

interface FanRow {
  metric: string;
  label: string;
  p5: number;
  p25: number;
  p50: number;
  p75: number;
  p95: number;
  outerBase: number;
  outerSpan: number;
  innerBase: number;
  innerSpan: number;
}

function FanBandTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: FanRow }> }) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="bg-[var(--card-bg)] border border-[var(--card-border)] rounded-lg shadow-panel px-3 py-2">
      <p className="text-xs font-semibold text-[var(--text-primary)] mb-1">{d.label}</p>
      <p className="text-[11px] text-[var(--text-secondary)]">P5: {fmt(d.p5)}</p>
      <p className="text-[11px] text-[var(--text-secondary)]">P25: {fmt(d.p25)}</p>
      <p className="text-[11px] font-semibold text-[var(--text-primary)]">P50: {fmt(d.p50)}</p>
      <p className="text-[11px] text-[var(--text-secondary)]">P75: {fmt(d.p75)}</p>
      <p className="text-[11px] text-[var(--text-secondary)]">P95: {fmt(d.p95)}</p>
    </div>
  );
}

function FanBandChart({ result }: { result: MonteCarloResult }) {
  const rows: FanRow[] = useMemo(
    () =>
      Object.entries(result.fan_chart).map(([metric, fc]) => ({
        metric,
        label: METRIC_LABELS[metric] || metric,
        p5: fc.p5,
        p25: fc.p25,
        p50: fc.p50,
        p75: fc.p75,
        p95: fc.p95,
        outerBase: fc.p5,
        outerSpan: fc.p95 - fc.p5,
        innerBase: fc.p25,
        innerSpan: fc.p75 - fc.p25,
      })),
    [result],
  );
  const height = Math.max(rows.length * 44 + 30, 100);

  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} layout="vertical" margin={{ left: 8, right: 16 }}>
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
            dataKey="label"
            width={90}
            tick={{ fontSize: 11, fill: "var(--text-primary)" }}
            axisLine={false}
            tickLine={false}
          />
          <Tooltip content={<FanBandTooltip />} />
          {/* Outer band: P5-P95 */}
          <Bar dataKey="outerBase" stackId="outer" fill="transparent" />
          <Bar dataKey="outerSpan" stackId="outer" fill="var(--accent)" fillOpacity={0.2} radius={[3, 3, 3, 3]} barSize={22} />
          {/* Inner band: P25-P75 */}
          <Bar dataKey="innerBase" stackId="inner" fill="transparent" />
          <Bar dataKey="innerSpan" stackId="inner" fill="var(--accent)" fillOpacity={0.55} radius={[3, 3, 3, 3]} barSize={22}>
            {rows.map((r) => (
              <Cell key={r.metric} />
            ))}
          </Bar>
          {rows.map((r) => (
            <ReferenceLine key={r.metric} segment={[{ x: r.p50, y: r.label }, { x: r.p50, y: r.label }]} stroke="var(--accent)" />
          ))}
        </BarChart>
      </ResponsiveContainer>
      <ChartDataTable
        caption="Monte Carlo fan chart percentiles"
        columns={["Metric", "P5", "P25", "P50", "P75", "P95"]}
        rows={rows.map((r) => [r.label, r.p5, r.p25, r.p50, r.p75, r.p95])}
      />
    </div>
  );
}

// ── Histogram (Recharts) ──

function Histogram({ values, label }: { values: number[]; label: string }) {
  const buckets = useMemo(() => {
    if (values.length === 0) return [];
    const min = values[0];
    const max = values[values.length - 1];
    const bucketCount = 24;
    const bucketSize = (max - min) / bucketCount || 1;
    const counts = new Array(bucketCount).fill(0);
    for (const v of values) {
      const idx = Math.min(Math.floor((v - min) / bucketSize), bucketCount - 1);
      counts[idx]++;
    }
    return counts.map((count, i) => ({
      rangeStart: min + i * bucketSize,
      rangeEnd: min + (i + 1) * bucketSize,
      count,
      mid: min + (i + 0.5) * bucketSize,
    }));
  }, [values]);

  if (buckets.length === 0) return null;

  const HistTooltip = ({ active, payload }: { active?: boolean; payload?: Array<{ payload: (typeof buckets)[number] }> }) => {
    if (!active || !payload?.length) return null;
    const b = payload[0].payload;
    return (
      <div className="bg-[var(--card-bg)] border border-[var(--card-border)] rounded-lg shadow-panel px-2.5 py-1.5">
        <p className="text-[11px] text-[var(--text-secondary)]">{fmt(b.rangeStart)} – {fmt(b.rangeEnd)}</p>
        <p className="text-[11px] font-semibold text-[var(--text-primary)]">{b.count} iterations</p>
      </div>
    );
  };

  return (
    <div className="mb-4">
      <p className="text-xs font-medium mb-1.5 text-[var(--text-primary)]">{label} Distribution</p>
      <div className="h-32">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={buckets} barCategoryGap={1}>
            <XAxis
              dataKey="mid"
              tickFormatter={(v: number) => formatCompactCurrency(v, getCurrencySymbol())}
              tick={{ fontSize: 9, fill: "var(--text-faint)" }}
              axisLine={{ stroke: "var(--border)" }}
              tickLine={false}
              interval="preserveStartEnd"
            />
            <YAxis hide />
            <Tooltip content={<HistTooltip />} />
            <Bar dataKey="count" fill="var(--accent)" fillOpacity={0.6} radius={[2, 2, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
        <ChartDataTable
          caption={`${label} histogram`}
          columns={["Range start", "Range end", "Count"]}
          rows={buckets.map((b) => [b.rangeStart, b.rangeEnd, b.count])}
        />
      </div>
    </div>
  );
}

// ── Stat readout: VaR/CVaR/prob-negative/CI ──

function RiskStats({ metric, data }: { metric: string; data: PercentileResult }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3 p-2.5 rounded-lg bg-[var(--panel-bg)] border border-[var(--border-light)]">
      <div>
        <p className="text-[9px] uppercase tracking-wider text-[var(--text-faint)]">VaR (5%)</p>
        <p className="text-xs font-semibold text-[var(--text-primary)]">{fmt(data.var_5)}</p>
      </div>
      <div>
        <p className="text-[9px] uppercase tracking-wider text-[var(--text-faint)]">CVaR (5%)</p>
        <p className="text-xs font-semibold text-[var(--danger)]">{fmt(data.cvar_5)}</p>
      </div>
      <div>
        <p className="text-[9px] uppercase tracking-wider text-[var(--text-faint)]">P(Negative)</p>
        <p className="text-xs font-semibold text-[var(--text-primary)]">{(data.prob_negative * 100).toFixed(1)}%</p>
      </div>
      <div>
        <p className="text-[9px] uppercase tracking-wider text-[var(--text-faint)]">95% CI (mean)</p>
        <p className="text-xs font-semibold text-[var(--text-primary)]">{fmt(data.mean_ci_95[0])} – {fmt(data.mean_ci_95[1])}</p>
      </div>
      <p className="text-[9px] text-[var(--text-primary)] col-span-2 sm:col-span-4">{METRIC_LABELS[metric] || metric}</p>
    </div>
  );
}

export function MonteCarloView({ scenarioId, onClose, onMinimize }: MonteCarloViewProps) {
  const [result, setResult] = useState<MonteCarloResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [iterations, setIterations] = useState(5000);
  const [selectedMetric, setSelectedMetric] = useState("net_income");

  const run = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await runMonteCarlo(scenarioId, iterations);
      setResult(data);
      const keys = Object.keys(data.metrics);
      if (keys.length > 0 && !keys.includes(selectedMetric)) setSelectedMetric(keys[0]);
    } catch (e) {
      setError((e as Error).message);
    }
    setLoading(false);
  }, [scenarioId, iterations, selectedMetric]);

  return (
    <div className="border-t border-[var(--border)] bg-background p-4 max-h-[60vh] overflow-auto">
      <PanelHeader
        title="Monte Carlo Simulation"
        icon={<div className="w-5 h-5 rounded-md bg-accent/10 flex items-center justify-center"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2.5"><path d="M12 20V10M18 20V4M6 20v-4" /></svg></div>}
        onClose={onClose}
        onMinimize={onMinimize || onClose}
        isMinimized={false}
      />
      {/* Config */}
      <div className="flex items-center gap-3 mb-4 bg-[var(--panel-bg)] rounded-xl border border-[var(--panel-border)] p-3">
        <label className="text-xs text-[var(--text-muted)]">
          Iterations:
          <input
            type="number"
            min={100}
            max={20000}
            step={500}
            value={iterations}
            onChange={(e) => setIterations(Number(e.target.value))}
            className="ml-1.5 w-20 rounded-lg border border-[var(--input-border)] bg-[var(--card-bg)] px-2 py-1 text-xs focus:outline-none focus:border-[var(--input-focus-border)] focus:ring-1 focus:ring-accent/20"
          />
        </label>
        <button
          onClick={run}
          disabled={loading}
          className="rounded-lg bg-accent px-4 py-1.5 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-40 shadow-sm transition-colors"
        >
          {loading ? "Running..." : "Run Monte Carlo"}
        </button>
      </div>

      {error && <p className="text-xs text-[var(--danger)] mb-2 bg-[var(--danger-bg)] px-3 py-1.5 rounded-lg">{error}</p>}

      {result && (
        <>
          <p className="text-xs text-[var(--text-faint)] mb-1">
            {result.iterations.toLocaleString()} iterations completed
            {result.iterations < result.requested_iterations ? ` (of ${result.requested_iterations.toLocaleString()} requested)` : ""}
            {" · "}seed {result.seed} — reproducible
          </p>
          {result.notices && result.notices.length > 0 && (
            <div className="mb-3 space-y-1">
              {result.notices.map((n, i) => (
                <p key={i} className="text-[11px] text-[var(--warning)] bg-[var(--warning-bg)] px-2.5 py-1 rounded-lg">{n}</p>
              ))}
            </div>
          )}

          {/* Distribution overview (fan band) */}
          <div className="mb-4">
            <h4 className="text-[11px] font-semibold mb-2.5 text-[var(--text-muted)] uppercase tracking-wider">
              Distribution Overview (P5–P95 outer, P25–P75 inner, P50 marker)
            </h4>
            <FanBandChart result={result} />
          </div>

          {/* Histogram + risk stats for selected metric */}
          <div className="mb-3">
            <label className="text-xs text-[var(--text-muted)] mr-2">Metric detail:</label>
            <select
              value={selectedMetric}
              onChange={(e) => setSelectedMetric(e.target.value)}
              className="rounded-lg border border-[var(--input-border)] bg-[var(--card-bg)] px-2 py-1 text-xs focus:outline-none focus:border-[var(--input-focus-border)]"
            >
              {Object.keys(result.metrics).map((m) => (
                <option key={m} value={m}>{METRIC_LABELS[m] || m}</option>
              ))}
            </select>
          </div>
          {result.metrics[selectedMetric] && <RiskStats metric={selectedMetric} data={result.metrics[selectedMetric]} />}
          {result.distributions[selectedMetric] && (
            <Histogram
              values={[...result.distributions[selectedMetric]].sort((a, b) => a - b)}
              label={METRIC_LABELS[selectedMetric] || selectedMetric}
            />
          )}
        </>
      )}
    </div>
  );
}
