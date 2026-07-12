"use client";

import { useUiStore } from "@/stores/uiStore";
import type { DimensionalResultBlock } from "@/lib/api";
import { getCurrencySymbol } from "@/lib/metrics";
import { getMemberName, setPovMember } from "@/lib/dimensionalPov";

interface Props {
  dimensional: DimensionalResultBlock;
  onPovChange?: (pov: Record<string, string>, metrics?: string[]) => void | Promise<void>;
  loading?: boolean;
}

/**
 * POV / dimension pickers — only rendered when simulation output includes a dimensional block.
 * Drives breakdown display from store POV state.
 */
export function DimensionPovControls({ dimensional, onPovChange, loading }: Props) {
  const { dimensionalPov, setDimensionalPov, dimensionalMetric, setDimensionalMetric } = useUiStore();

  const metrics = Object.keys(dimensional.breakdowns);
  const metric = dimensionalMetric && metrics.includes(dimensionalMetric) ? dimensionalMetric : metrics[0];
  const metricBreakdowns = metric ? dimensional.breakdowns[metric] : undefined;

  if (!metrics.length) return null;

  return (
    <div className="space-y-3 border-t border-[var(--border)] pt-3 mt-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
          Dimensional POV
        </span>
        <select
          className="text-xs rounded-md border border-[var(--border)] bg-[var(--card-bg)] px-2 py-1"
          value={metric || ""}
          onChange={(e) => {
            setDimensionalMetric(e.target.value);
            void onPovChange?.(dimensionalPov, [e.target.value]);
          }}
        >
          {metrics.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-wrap gap-2">
        {dimensional.dimensions
          .filter((d) => d.type !== "version")
          .map((dim) => {
            const members = metricBreakdowns?.[dim.id]
              ? Object.keys(metricBreakdowns[dim.id])
              : [];
            if (members.length === 0) return null;
            return (
              <label key={dim.id} className="text-xs flex items-center gap-1.5">
                <span className="text-[var(--text-muted)]">{dim.name}</span>
                <select
                  className="rounded-md border border-[var(--border)] bg-[var(--card-bg)] px-2 py-1"
                  value={dimensionalPov[dim.id] || ""}
                  onChange={(e) => {
                    const next = setPovMember(dimensionalPov, dim.id, e.target.value);
                    setDimensionalPov(next);
                    void onPovChange?.(next, metric ? [metric] : undefined);
                  }}
                >
                  <option value="">All</option>
                  {members.map((mid) => (
                    <option key={mid} value={mid}>
                      {getMemberName(dimensional.member_catalog, dim.id, mid)}
                    </option>
                  ))}
                </select>
              </label>
            );
          })}
      </div>

      {Object.keys(dimensionalPov).length > 0 && (
        <button
          type="button"
          disabled={loading}
          onClick={() => {
            setDimensionalPov({});
            void onPovChange?.({}, metric ? [metric] : undefined);
          }}
          className="text-xs text-accent hover:underline disabled:opacity-40"
        >
          {loading ? "Updating…" : "Clear POV"}
        </button>
      )}

      {metric && metricBreakdowns && (
        <div className="space-y-2">
          {Object.entries(metricBreakdowns).map(([dimId, slice]) => {
            const dim = dimensional.dimensions.find((d) => d.id === dimId);
            const povMember = dimensionalPov[dimId];
            const entries = Object.entries(slice).filter(([mid]) => !povMember || mid === povMember);
            if (entries.length === 0) return null;
            return (
              <div key={dimId}>
                <div className="text-[11px] font-medium text-[var(--text-muted)] mb-1">
                  {dim?.name || dimId}
                </div>
                <div className="grid grid-cols-2 gap-1">
                  {entries.map(([mid, val]) => (
                    <div
                      key={mid}
                      className="flex justify-between text-xs px-2 py-1 rounded bg-[var(--panel-bg)]"
                    >
                      <span>{getMemberName(dimensional.member_catalog, dimId, mid)}</span>
                      <span className="font-medium tabular-nums">
                        {getCurrencySymbol()}
                        {val.toLocaleString()}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
