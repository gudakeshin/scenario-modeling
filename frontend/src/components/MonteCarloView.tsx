"use client";

import { useState, useCallback } from "react";
import { PanelHeader } from "./PanelHeader";
import { runMonteCarlo, type MonteCarloResult, type PercentileResult } from "@/lib/api";
import { METRIC_LABELS } from "@/lib/metrics";

interface MonteCarloViewProps {
  scenarioId: string;
  onClose: () => void;
  onMinimize?: () => void;
}

function fmt(n: number) {
  return "$" + n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

function DistributionBar({ metric, data }: { metric: string; data: PercentileResult }) {
  const range = data.max - data.min || 1;
  const p10Pct = ((data.p10 - data.min) / range) * 100;
  const p90Pct = ((data.p90 - data.min) / range) * 100;
  const p50Pct = ((data.p50 - data.min) / range) * 100;

  return (
    <div className="mb-3">
      <div className="flex items-center justify-between text-xs mb-1">
        <span className="font-medium text-[var(--text-primary)]">{METRIC_LABELS[metric] || metric}</span>
        <span className="text-[var(--text-faint)]">
          P50: {fmt(data.p50)} | Mean: {fmt(data.mean)}
        </span>
      </div>
      <div className="relative h-7 bg-[var(--panel-bg)] border border-[var(--border-light)] rounded-full overflow-hidden">
        {/* P10-P90 band */}
        <div
          className="absolute top-0 h-full bg-accent/25 rounded-full"
          style={{ left: `${p10Pct}%`, width: `${p90Pct - p10Pct}%` }}
        />
        {/* P50 line */}
        <div
          className="absolute top-0 h-full w-0.5 bg-accent"
          style={{ left: `${p50Pct}%` }}
        />
      </div>
      <div className="flex justify-between text-[10px] text-[var(--text-faint)] mt-0.5">
        <span>P10: {fmt(data.p10)}</span>
        <span>P90: {fmt(data.p90)}</span>
      </div>
    </div>
  );
}

function Histogram({ values, label }: { values: number[]; label: string }) {
  if (values.length === 0) return null;
  const min = values[0];
  const max = values[values.length - 1];
  const bucketCount = 20;
  const bucketSize = (max - min) / bucketCount || 1;
  const buckets = new Array(bucketCount).fill(0);
  for (const v of values) {
    const idx = Math.min(Math.floor((v - min) / bucketSize), bucketCount - 1);
    buckets[idx]++;
  }
  const maxBucket = Math.max(...buckets);

  return (
    <div className="mb-4">
      <p className="text-xs font-medium mb-1.5 text-[var(--text-primary)]">{label} Distribution</p>
      <div className="flex items-end gap-px h-20 bg-[var(--panel-bg)] rounded-xl border border-[var(--border-light)] p-2">
        {buckets.map((count, i) => (
          <div
            key={i}
            className="flex-1 bg-accent/50 hover:bg-accent/70 rounded-t-sm min-w-[2px] transition-colors"
            style={{ height: `${maxBucket > 0 ? (count / maxBucket) * 100 : 0}%` }}
            title={`${fmt(min + i * bucketSize)} \u2013 ${fmt(min + (i + 1) * bucketSize)}: ${count}`}
          />
        ))}
      </div>
      <div className="flex justify-between text-[10px] text-[var(--text-faint)] mt-0.5">
        <span>{fmt(min)}</span>
        <span>{fmt(max)}</span>
      </div>
    </div>
  );
}

export function MonteCarloView({ scenarioId, onClose, onMinimize }: MonteCarloViewProps) {
  const [result, setResult] = useState<MonteCarloResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [iterations, setIterations] = useState(1000);
  const [selectedMetric, setSelectedMetric] = useState("net_income");

  const run = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await runMonteCarlo(scenarioId, iterations);
      setResult(data);
    } catch (e) {
      setError((e as Error).message);
    }
    setLoading(false);
  }, [scenarioId, iterations]);

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
            max={10000}
            step={100}
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
          <p className="text-xs text-[var(--text-faint)] mb-3">{result.iterations} iterations completed</p>

          {/* Confidence intervals */}
          <div className="mb-4">
            <h4 className="text-[11px] font-semibold mb-2.5 text-[var(--text-muted)] uppercase tracking-wider">Confidence Intervals (P10 / P50 / P90)</h4>
            {Object.entries(result.metrics).map(([metric, data]) => (
              <DistributionBar key={metric} metric={metric} data={data} />
            ))}
          </div>

          {/* Histogram for selected metric */}
          <div className="mb-3">
            <label className="text-xs text-[var(--text-muted)] mr-2">Histogram:</label>
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
          {result.distributions[selectedMetric] && (
            <Histogram
              values={[...result.distributions[selectedMetric]].sort((a, b) => a - b)}
              label={METRIC_LABELS[selectedMetric] || selectedMetric}
            />
          )}

          {/* Fan chart summary table */}
          <h4 className="text-[11px] font-semibold mb-2 text-[var(--text-muted)] uppercase tracking-wider">Fan Chart Summary</h4>
          <div className="rounded-xl border border-[var(--card-border)] overflow-hidden mb-2">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-[var(--panel-bg)]">
                  <th className="py-2 px-3 text-left font-medium text-[var(--text-secondary)]">Metric</th>
                  <th className="py-2 px-3 text-right font-medium text-[var(--text-secondary)]">P10</th>
                  <th className="py-2 px-3 text-right font-medium text-[var(--text-secondary)]">P25</th>
                  <th className="py-2 px-3 text-right font-medium text-[var(--text-secondary)]">P50</th>
                  <th className="py-2 px-3 text-right font-medium text-[var(--text-secondary)]">P75</th>
                  <th className="py-2 px-3 text-right font-medium text-[var(--text-secondary)]">P90</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(result.fan_chart).map(([m, fc]) => (
                  <tr key={m} className="border-t border-[var(--border-light)] hover:bg-[var(--panel-bg)] transition-colors">
                    <td className="py-1.5 px-3 font-medium text-[var(--text-primary)]">{METRIC_LABELS[m] || m}</td>
                    <td className="py-1.5 px-3 text-right text-[var(--text-secondary)]">{fmt(fc.p10)}</td>
                    <td className="py-1.5 px-3 text-right text-[var(--text-secondary)]">{fmt(fc.p25)}</td>
                    <td className="py-1.5 px-3 text-right font-semibold text-[var(--text-primary)]">{fmt(fc.p50)}</td>
                    <td className="py-1.5 px-3 text-right text-[var(--text-secondary)]">{fmt(fc.p75)}</td>
                    <td className="py-1.5 px-3 text-right text-[var(--text-secondary)]">{fmt(fc.p90)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
