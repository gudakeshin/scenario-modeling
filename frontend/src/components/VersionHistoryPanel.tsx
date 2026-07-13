"use client";

import { useCallback, useEffect, useState } from "react";
import { PanelHeader } from "./PanelHeader";
import {
  listScenarioVersions,
  createScenarioVersion,
  diffScenarioVersions,
  getScenarioOutputs,
  type ScenarioVersion,
  type ScenarioVersionDiff,
} from "@/lib/api";
import { fmtMetric, fmtMetricSigned, metricLabel } from "@/lib/metrics";

interface VersionHistoryPanelProps {
  scenarioId: string;
  onClose: () => void;
  onMinimize?: () => void;
}

export function VersionHistoryPanel({ scenarioId, onClose, onMinimize }: VersionHistoryPanelProps) {
  const [versions, setVersions] = useState<ScenarioVersion[]>([]);
  const [fromVer, setFromVer] = useState<number | null>(null);
  const [toVer, setToVer] = useState<number | null>(null);
  const [diff, setDiff] = useState<ScenarioVersionDiff | null>(null);
  const [loading, setLoading] = useState(true);
  const [diffing, setDiffing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [label, setLabel] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await listScenarioVersions(scenarioId);
      setVersions(list);
      if (list.length >= 2) {
        setToVer(list[0].version_number);
        setFromVer(list[1].version_number);
      } else if (list.length === 1) {
        setToVer(list[0].version_number);
        setFromVer(list[0].version_number);
      }
    } catch (e) {
      setError((e as Error).message);
    }
    setLoading(false);
  }, [scenarioId]);

  useEffect(() => {
    load();
  }, [load]);

  const runDiff = useCallback(async () => {
    if (fromVer == null || toVer == null) return;
    setDiffing(true);
    setError(null);
    try {
      setDiff(await diffScenarioVersions(scenarioId, fromVer, toVer));
    } catch (e) {
      setError((e as Error).message);
    }
    setDiffing(false);
  }, [scenarioId, fromVer, toVer]);

  useEffect(() => {
    if (fromVer != null && toVer != null && fromVer !== toVer) {
      runDiff();
    } else {
      setDiff(null);
    }
  }, [fromVer, toVer, runDiff]);

  const snapshot = async () => {
    setSaving(true);
    setError(null);
    try {
      const outs = await getScenarioOutputs(scenarioId);
      const plRow = outs.find((o) => o.output_type === "pl");
      const raw = (plRow?.output_data ?? {}) as { aggregate?: Record<string, number> } & Record<string, number>;
      const outputs = (raw.aggregate && typeof raw.aggregate === "object" ? raw.aggregate : raw) as Record<
        string,
        number
      >;
      const numericOutputs: Record<string, number> = {};
      for (const [k, v] of Object.entries(outputs)) {
        if (typeof v === "number" && Number.isFinite(v)) numericOutputs[k] = v;
      }
      if (Object.keys(numericOutputs).length === 0) {
        throw new Error("No P&L outputs to snapshot — run the scenario first.");
      }
      await createScenarioVersion(scenarioId, {
        label: label.trim() || undefined,
        outputs: numericOutputs,
      });
      setLabel("");
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
    setSaving(false);
  };

  const deltaEntries = diff
    ? Object.entries(diff.output_deltas).sort(([a], [b]) => a.localeCompare(b))
    : [];

  return (
    <div className="border-t border-[var(--border)] bg-background p-4 max-h-[60vh] overflow-auto">
      <PanelHeader
        title="Version History"
        icon={
          <div className="w-5 h-5 rounded-md bg-accent/10 flex items-center justify-center">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--accent, #86BC25)" strokeWidth="2.5">
              <circle cx="12" cy="12" r="3" />
              <path d="M12 2v4M12 18v4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M2 12h4M18 12h4M4.9 19.1l2.8-2.8M16.3 7.7l2.8-2.8" />
            </svg>
          </div>
        }
        onClose={onClose}
        onMinimize={onMinimize || onClose}
        isMinimized={false}
      />

      {error && (
        <p className="text-xs text-[var(--danger)] mb-2 bg-[var(--danger-bg)] px-3 py-1.5 rounded-lg">{error}</p>
      )}

      <div className="flex flex-wrap items-end gap-2 mb-3 bg-[var(--panel-bg)] rounded-xl border border-[var(--panel-border)] p-3">
        <label className="text-xs text-[var(--text-muted)]">
          Snapshot label
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="optional"
            className="ml-1.5 w-36 rounded-lg border border-[var(--input-border)] bg-[var(--card-bg)] px-2 py-1 text-xs"
          />
        </label>
        <button
          type="button"
          onClick={snapshot}
          disabled={saving || loading}
          className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-40"
        >
          {saving ? "Saving…" : "Save version"}
        </button>
      </div>

      {loading ? (
        <p className="text-xs text-[var(--text-muted)]">Loading versions…</p>
      ) : versions.length === 0 ? (
        <p className="text-xs text-[var(--text-muted)]">No versions yet. Save a snapshot after a run.</p>
      ) : (
        <>
          <ul className="space-y-1.5 mb-4">
            {versions.map((v) => (
              <li
                key={v.version_id}
                className="flex items-center justify-between gap-2 rounded-lg border border-[var(--border)] bg-[var(--card-bg)] px-3 py-2 text-xs"
              >
                <div>
                  <span className="font-medium text-[var(--text-primary)]">
                    {v.label || `v${v.version_number}`}
                  </span>
                  <span className="ml-2 text-[var(--text-faint)]">#{v.version_number}</span>
                </div>
                <span className="text-[var(--text-faint)] shrink-0">
                  {new Date(v.created_at).toLocaleString()}
                </span>
              </li>
            ))}
          </ul>

          <div className="flex flex-wrap items-center gap-3 mb-3">
            <label className="text-xs text-[var(--text-muted)]">
              From
              <select
                value={fromVer ?? ""}
                onChange={(e) => setFromVer(Number(e.target.value))}
                className="ml-1.5 rounded-lg border border-[var(--input-border)] bg-[var(--card-bg)] px-2 py-1 text-xs"
              >
                {versions.map((v) => (
                  <option key={v.version_id} value={v.version_number}>
                    {v.label || `v${v.version_number}`}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs text-[var(--text-muted)]">
              To
              <select
                value={toVer ?? ""}
                onChange={(e) => setToVer(Number(e.target.value))}
                className="ml-1.5 rounded-lg border border-[var(--input-border)] bg-[var(--card-bg)] px-2 py-1 text-xs"
              >
                {versions.map((v) => (
                  <option key={v.version_id} value={v.version_number}>
                    {v.label || `v${v.version_number}`}
                  </option>
                ))}
              </select>
            </label>
            {diffing && <span className="text-[11px] text-[var(--text-faint)]">Diffing…</span>}
          </div>

          {diff && deltaEntries.length > 0 && (
            <div className="overflow-x-auto rounded-xl border border-[var(--border)]">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-[var(--panel-bg)] text-[var(--text-muted)] text-left">
                    <th className="px-3 py-2 font-medium">Metric</th>
                    <th className="px-3 py-2 font-medium text-right">From</th>
                    <th className="px-3 py-2 font-medium text-right">To</th>
                    <th className="px-3 py-2 font-medium text-right">Delta</th>
                  </tr>
                </thead>
                <tbody>
                  {deltaEntries.map(([key, row]) => (
                    <tr key={key} className="border-t border-[var(--border)]">
                      <td className="px-3 py-1.5 text-[var(--text-primary)]">{metricLabel(key)}</td>
                      <td className="px-3 py-1.5 text-right text-[var(--text-muted)]">
                        {row.from != null ? fmtMetric(key, row.from) : "—"}
                      </td>
                      <td className="px-3 py-1.5 text-right text-[var(--text-primary)]">
                        {row.to != null ? fmtMetric(key, row.to) : "—"}
                      </td>
                      <td
                        className={`px-3 py-1.5 text-right font-medium ${
                          (row.delta ?? 0) >= 0 ? "text-[var(--success)]" : "text-[var(--danger)]"
                        }`}
                      >
                        {row.delta != null ? fmtMetricSigned(key, row.delta) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {diff && deltaEntries.length === 0 && fromVer !== toVer && (
            <p className="text-xs text-[var(--text-muted)]">No output deltas between selected versions.</p>
          )}
        </>
      )}
    </div>
  );
}
