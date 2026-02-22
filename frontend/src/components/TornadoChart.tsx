"use client";

import { useState, useCallback, useEffect } from "react";
import { runSensitivity, getActiveModel, type SensitivityResult, type TornadoBar } from "@/lib/api";
import { PanelHeader } from "./PanelHeader";
import { fmtCurrency, fmtCurrencySigned } from "@/lib/metrics";

interface TornadoChartProps {
  scenarioId: string;
  onClose: () => void;
  onMinimize?: () => void;
}

function labelFromId(id: string): string {
  return id.split("_").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

/**
 * Tornado bar: shows negative impact (left, red) and positive impact (right, green).
 * Handles sign correctly — for cost variables, decreasing the variable (low scenario)
 * can increase the metric, so low_delta can be positive.
 */
function Bar({ bar, maxDelta }: { bar: TornadoBar; maxDelta: number }) {
  // Determine which delta goes left (negative/downside) and which goes right (positive/upside)
  const negDelta = Math.min(bar.low_delta, bar.high_delta);
  const posDelta = Math.max(bar.low_delta, bar.high_delta);
  const leftPct = maxDelta > 0 ? (Math.abs(negDelta) / maxDelta) * 100 : 0;
  const rightPct = maxDelta > 0 ? (Math.abs(posDelta) / maxDelta) * 100 : 0;

  return (
    <div className="flex items-center gap-2 mb-2.5">
      <div className="w-32 text-right text-xs font-medium truncate text-[var(--text-primary)]" title={bar.variable_name}>
        {bar.variable_name}
      </div>
      <div className="flex-1 flex items-center h-8">
        {/* Left (negative/downside) bar */}
        <div className="flex-1 flex justify-end">
          <div
            className="h-6 rounded-l-md flex items-center justify-end pr-1.5 transition-all"
            style={{
              width: `${leftPct}%`,
              minWidth: leftPct > 0 ? "4px" : "0",
              backgroundColor: "rgba(218, 41, 28, 0.55)",
            }}
          >
            {leftPct > 15 && (
              <span className="text-[10px] text-white whitespace-nowrap font-medium drop-shadow-sm">
                {fmtCurrencySigned(negDelta)}
              </span>
            )}
          </div>
        </div>
        {/* Center line (base) */}
        <div className="w-0.5 h-8 bg-[var(--text-muted)]/40 rounded-full" />
        {/* Right (positive/upside) bar */}
        <div className="flex-1">
          <div
            className="h-6 rounded-r-md flex items-center pl-1.5 transition-all"
            style={{
              width: `${rightPct}%`,
              minWidth: rightPct > 0 ? "4px" : "0",
              backgroundColor: "rgba(134, 188, 37, 0.65)",
            }}
          >
            {rightPct > 15 && (
              <span className="text-[10px] text-white whitespace-nowrap font-medium drop-shadow-sm">
                {fmtCurrencySigned(posDelta)}
              </span>
            )}
          </div>
        </div>
      </div>
      {/* Labels outside bars when they don't fit inside */}
      <div className="w-20 text-right flex flex-col items-end">
        <span className="text-[10px] font-semibold text-[var(--text-secondary)]">{fmtCurrency(bar.spread)}</span>
        <span className="text-[9px] text-[var(--text-faint)]">{bar.base_value !== 0 ? ((bar.spread / Math.abs(bar.base_value)) * 100).toFixed(1) : 0}%</span>
      </div>
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

  // Max absolute delta across all bars — used to scale bar widths
  const maxDelta = result
    ? Math.max(...result.bars.flatMap((b) => [Math.abs(b.low_delta), Math.abs(b.high_delta)]), 1)
    : 1;

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
            Base {metricOptions.find((o) => o.value === result.target_metric)?.label || labelFromId(result.target_metric)}: {fmtCurrency(result.base_metric_value)} | \u00B1{result.swing_pct}% swing
          </p>

          {/* Header */}
          <div className="flex items-center gap-2 mb-2 text-[10px] text-[var(--text-faint)] font-medium uppercase tracking-wider">
            <div className="w-32 text-right">Variable</div>
            <div className="flex-1 flex">
              <div className="flex-1 text-right text-[var(--danger)]">{"\u2190"} Downside</div>
              <div className="w-0.5" />
              <div className="flex-1 text-[rgb(134,188,37)]">Upside {"\u2192"}</div>
            </div>
            <div className="w-20 text-right">Spread</div>
          </div>

          {/* Bars */}
          {result.bars.map((bar) => (
            <Bar key={bar.variable_id} bar={bar} maxDelta={maxDelta} />
          ))}

          {result.bars.length === 0 && (
            <p className="text-xs text-[var(--text-faint)]">No input variables found to analyze.</p>
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
