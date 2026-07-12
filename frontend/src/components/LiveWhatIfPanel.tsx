"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PanelHeader } from "./PanelHeader";
import {
  getParameters,
  previewScenario,
  updateParameter,
  type StoredParameter,
} from "@/lib/api";
import { fmtCurrency } from "@/lib/metrics";

interface LiveWhatIfPanelProps {
  scenarioId: string;
  onClose: () => void;
  onMinimize?: () => void;
}

const PREVIEW_DEBOUNCE_MS = 400;

function isApproved(p: StoredParameter): boolean {
  return p.status === "accepted" || p.status === "modified";
}

export function LiveWhatIfPanel({ scenarioId, onClose, onMinimize }: LiveWhatIfPanelProps) {
  const [levers, setLevers] = useState<StoredParameter[]>([]);
  const [drafts, setDrafts] = useState<Record<string, number>>({});
  const [previewPl, setPreviewPl] = useState<Record<string, number> | null>(null);
  const [loading, setLoading] = useState(true);
  const [previewing, setPreviewing] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applyMsg, setApplyMsg] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestId = useRef(0);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = await getParameters(scenarioId);
      const approved = params.filter(isApproved);
      setLevers(approved);
      const next: Record<string, number> = {};
      for (const p of approved) next[p.parameter_id] = p.scenario_value;
      setDrafts(next);
    } catch (e) {
      setError((e as Error).message);
    }
    setLoading(false);
  }, [scenarioId]);

  useEffect(() => {
    load();
  }, [load]);

  const dirty = useMemo(() => {
    return levers.some((p) => drafts[p.parameter_id] !== p.scenario_value);
  }, [levers, drafts]);

  const runPreview = useCallback(
    async (nextDrafts: Record<string, number>, params: StoredParameter[]) => {
      const id = ++requestId.current;
      setPreviewing(true);
      setError(null);
      try {
        const payload = params
          .filter((p) => p.mapped_variable_id)
          .map((p) => ({
            variable_id: p.mapped_variable_id,
            value: nextDrafts[p.parameter_id] ?? p.scenario_value,
            delta_type: (p.delta_type ?? "percent") as "percent" | "absolute",
          }));
        const result = await previewScenario(scenarioId, payload);
        if (id !== requestId.current) return;
        const pl =
          (result.pl as Record<string, number> | undefined) ??
          (result.aggregate as Record<string, number> | undefined) ??
          null;
        setPreviewPl(pl);
      } catch (e) {
        if (id !== requestId.current) return;
        setError((e as Error).message);
      }
      if (id === requestId.current) setPreviewing(false);
    },
    [scenarioId],
  );

  useEffect(() => {
    if (levers.length === 0) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      runPreview(drafts, levers);
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [drafts, levers, runPreview]);

  const setDraft = (parameterId: string, value: number) => {
    setApplyMsg(null);
    setDrafts((prev) => ({ ...prev, [parameterId]: value }));
  };

  const handleApply = async () => {
    setApplying(true);
    setError(null);
    setApplyMsg(null);
    try {
      for (const p of levers) {
        const v = drafts[p.parameter_id];
        if (v !== p.scenario_value && Number.isFinite(v)) {
          await updateParameter(scenarioId, p.parameter_id, {
            scenario_value: v,
            status: "modified",
          });
        }
      }
      setApplyMsg("Applied — values saved to scenario parameters (not auto-run).");
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
    setApplying(false);
  };

  const handleReset = () => {
    const next: Record<string, number> = {};
    for (const p of levers) next[p.parameter_id] = p.scenario_value;
    setDrafts(next);
    setApplyMsg(null);
  };

  const highlightKeys = ["revenue", "net_income", "gross_profit", "ebitda", "operating_income"];
  const previewRows = previewPl
    ? Object.entries(previewPl)
        .filter(([k]) => highlightKeys.includes(k) || highlightKeys.some((h) => k.includes(h)))
        .slice(0, 8)
    : [];

  return (
    <div className="border-t border-[var(--border)] bg-background p-4 max-h-[60vh] overflow-auto">
      <PanelHeader
        title="Live What-If"
        icon={
          <div className="w-5 h-5 rounded-md bg-[var(--warning-bg)] flex items-center justify-center">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--warning)" strokeWidth="2.5">
              <path d="M4 20V10M10 20V4M16 20v-8M20 20V8" />
            </svg>
          </div>
        }
        onClose={onClose}
        onMinimize={onMinimize || onClose}
        isMinimized={false}
      />

      <p className="text-[11px] text-[var(--text-faint)] mb-3">
        Adjust approved levers for a live preview. Changes are not persisted until you click Apply.
      </p>

      {error && (
        <p className="text-xs text-[var(--danger)] mb-2 bg-[var(--danger-bg)] px-3 py-1.5 rounded-lg">{error}</p>
      )}
      {applyMsg && (
        <p className="text-xs text-[var(--success)] mb-2 bg-[var(--success-bg)] px-3 py-1.5 rounded-lg">{applyMsg}</p>
      )}

      {loading ? (
        <p className="text-xs text-[var(--text-muted)]">Loading levers…</p>
      ) : levers.length === 0 ? (
        <p className="text-xs text-[var(--text-muted)]">
          No approved levers yet. Accept parameters in Review first.
        </p>
      ) : (
        <div className="space-y-3 mb-4">
          {levers.map((p) => {
            const val = drafts[p.parameter_id] ?? p.scenario_value;
            const isPct = (p.delta_type ?? "percent") === "percent";
            const min = isPct ? -50 : Math.min(0, val * 0.5);
            const max = isPct ? 100 : Math.max(val * 1.5, val + 1, 100);
            return (
              <div
                key={p.parameter_id}
                className="rounded-xl border border-[var(--border)] bg-[var(--card-bg)] p-3"
              >
                <div className="flex items-center justify-between gap-2 mb-2">
                  <span className="text-xs font-medium text-[var(--text-primary)]">
                    {p.extracted_name}
                  </span>
                  <span className="text-[10px] text-[var(--text-faint)]">
                    {p.mapped_variable_id}
                    {isPct ? " · %" : ""}
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  <input
                    type="range"
                    min={min}
                    max={max}
                    step={isPct ? 0.5 : 1}
                    value={val}
                    onChange={(e) => setDraft(p.parameter_id, Number(e.target.value))}
                    className="flex-1 accent-[var(--accent,#86BC25)]"
                  />
                  <input
                    type="number"
                    value={val}
                    onChange={(e) => setDraft(p.parameter_id, Number(e.target.value))}
                    className="w-20 rounded-lg border border-[var(--input-border)] bg-[var(--panel-bg)] px-2 py-1 text-xs text-right"
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 mb-3">
        <button
          type="button"
          onClick={handleApply}
          disabled={!dirty || applying || levers.length === 0}
          className="rounded-lg bg-accent px-4 py-1.5 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-40"
        >
          {applying ? "Applying…" : "Apply"}
        </button>
        <button
          type="button"
          onClick={handleReset}
          disabled={!dirty || applying}
          className="rounded-lg border border-[var(--border)] bg-[var(--card-bg)] px-3 py-1.5 text-xs text-[var(--text-muted)] hover:border-[var(--panel-border)] disabled:opacity-40"
        >
          Reset drafts
        </button>
        {previewing && <span className="text-[11px] text-[var(--text-faint)]">Previewing…</span>}
      </div>

      {previewRows.length > 0 && (
        <div className="rounded-xl border border-[var(--border)] overflow-hidden">
          <div className="px-3 py-2 bg-[var(--panel-bg)] text-[11px] font-medium text-[var(--text-muted)]">
            Preview P&amp;L (not saved)
          </div>
          <table className="w-full text-xs">
            <tbody>
              {previewRows.map(([k, v]) => (
                <tr key={k} className="border-t border-[var(--border)]">
                  <td className="px-3 py-1.5 text-[var(--text-primary)]">
                    {k.split("_").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ")}
                  </td>
                  <td className="px-3 py-1.5 text-right font-medium">{fmtCurrency(v)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
