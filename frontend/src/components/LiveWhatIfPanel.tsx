"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PanelHeader } from "./PanelHeader";
import {
  applyLeverValue,
  getParameters,
  previewScenario,
  type StoredParameter,
} from "@/lib/api";
import { fmtMetric, metricLabel, useCurrencyVersion } from "@/lib/metrics";

interface LiveWhatIfPanelProps {
  scenarioId: string;
  onClose: () => void;
  onMinimize?: () => void;
}

interface WhatIfLever {
  /** Stable UI key */
  key: string;
  variableId: string;
  label: string;
  /** Absolute base from the model (for percent math). */
  base: number;
  /** Current draft as percent delta from base (what-if convention). */
  draftPct: number;
  /** Linked scenario parameter when present. */
  parameterId?: string;
  /** Original stored delta_type for apply-back to scenario params. */
  storedDeltaType?: "percent" | "absolute" | "additive";
  /** Original scenario_value when linked to a parameter (absolute/additive path). */
  storedValue?: number;
  source: "parameter" | "model";
}

const PREVIEW_DEBOUNCE_MS = 400;

function toFiniteNumber(value: unknown, fallback = 0): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function isActiveParam(p: StoredParameter): boolean {
  return p.status === "accepted" || p.status === "modified" || p.status === "pending";
}

/** Prefer levers that typically move P&L when picking a fallback set. */
function scoreLever(id: string, name: string): number {
  const t = `${id} ${name}`.toLowerCase();
  if (/material|cogs|cost_of|overhead|opex|expense/.test(t)) return 100;
  if (/revenue|price|nsp|volume|units|sales/.test(t)) return 90;
  if (/marketing|headcount|employee|fte|wage/.test(t)) return 70;
  if (/margin|rate|pct|percent/.test(t)) return 20;
  return 40;
}

export function LiveWhatIfPanel({ scenarioId, onClose, onMinimize }: LiveWhatIfPanelProps) {
  useCurrencyVersion();
  const [levers, setLevers] = useState<WhatIfLever[]>([]);
  const [previewPl, setPreviewPl] = useState<Record<string, number> | null>(null);
  const [basePl, setBasePl] = useState<Record<string, number> | null>(null);
  const [loading, setLoading] = useState(true);
  const [previewing, setPreviewing] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notices, setNotices] = useState<string[]>([]);
  const [applyMsg, setApplyMsg] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestId = useRef(0);
  const initialPct = useRef<Record<string, number>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setNotices([]);
    try {
      const [params, baseline] = await Promise.all([
        getParameters(scenarioId),
        previewScenario(scenarioId, []),
      ]);
      const modelLevers = (baseline.levers ?? []) as Array<{ id: string; name: string; base: number }>;
      const leverById = new Map(modelLevers.map((l) => [l.id, l]));
      const pl =
        (baseline.pl as Record<string, number> | undefined) ??
        (baseline.aggregate as Record<string, number> | undefined) ??
        null;
      setBasePl(pl);
      setPreviewPl(pl);
      if (Array.isArray(baseline.notices)) {
        setNotices(baseline.notices.map((n) => (typeof n === "string" ? n : String(n))));
      }

      const active = params.filter(isActiveParam);
      const fromParams: WhatIfLever[] = [];
      for (const p of active) {
        const mid = p.mapped_variable_id;
        if (!mid || !leverById.has(mid)) continue;
        const ml = leverById.get(mid)!;
        const base = toFiniteNumber(ml.base);
        const stored = toFiniteNumber(p.scenario_value);
        const deltaType = (p.delta_type ?? "percent") as "percent" | "absolute" | "additive";
        let draftPct = 0;
        if (deltaType === "percent") {
          draftPct = stored;
        } else if (deltaType === "additive" && base !== 0) {
          draftPct = (stored / Math.abs(base)) * 100;
        } else if (deltaType === "absolute" && base !== 0) {
          draftPct = ((stored - base) / Math.abs(base)) * 100;
        }
        fromParams.push({
          key: p.parameter_id,
          variableId: mid,
          label: p.extracted_name || ml.name || mid,
          base,
          draftPct,
          parameterId: p.parameter_id,
          storedDeltaType: deltaType,
          storedValue: stored,
          source: "parameter",
        });
      }

      let next = fromParams;
      if (modelLevers.length > 0) {
        const ranked = [...modelLevers]
          .map((l) => ({ ...l, score: scoreLever(l.id, l.name) }))
          .sort((a, b) => b.score - a.score);

        if (next.length === 0) {
          next = ranked.slice(0, 8).map((l) => ({
            key: `model:${l.id}`,
            variableId: l.id,
            label: l.name || l.id,
            base: toFiniteNumber(l.base),
            draftPct: 0,
            source: "model" as const,
          }));
          setNotices((prev) => [
            ...prev,
            "Scenario parameters are not mapped to model input levers, so Live What-If is using workbook inputs directly. Apply writes them as scenario levers.",
          ]);
        } else {
          // Keep mapped params, and always add top P&L movers so sliders aren't stuck on dead ids (e.g. "p")
          const seen = new Set(next.map((l) => l.variableId));
          for (const l of ranked) {
            if (seen.has(l.id) || next.length >= 10) continue;
            if (l.score < 70) continue;
            seen.add(l.id);
            next.push({
              key: `model:${l.id}`,
              variableId: l.id,
              label: l.name || l.id,
              base: toFiniteNumber(l.base),
              draftPct: 0,
              source: "model",
            });
          }
        }
      }

      if (active.length > 0 && fromParams.length < active.length) {
        const skipped = active
          .filter((p) => p.mapped_variable_id && !leverById.has(p.mapped_variable_id))
          .map((p) => p.mapped_variable_id);
        if (skipped.length) {
          setNotices((prev) => [
            ...prev,
            `Skipped non-input mappings (calculated outputs cannot be what-if'd): ${Array.from(new Set(skipped)).join(", ")}`,
          ]);
        }
      }

      const pctMap: Record<string, number> = {};
      for (const l of next) pctMap[l.key] = l.draftPct;
      initialPct.current = pctMap;
      setLevers(next);
    } catch (e) {
      setError((e as Error).message);
    }
    setLoading(false);
  }, [scenarioId]);

  useEffect(() => {
    load();
  }, [load]);

  const dirty = useMemo(() => {
    return levers.some((l) => Math.abs(l.draftPct - (initialPct.current[l.key] ?? 0)) > 1e-6);
  }, [levers]);

  const runPreview = useCallback(
    async (current: WhatIfLever[]) => {
      const id = ++requestId.current;
      setPreviewing(true);
      setError(null);
      try {
        const payload = current.map((l) => ({
          variable_id: l.variableId,
          value: l.draftPct,
          delta_type: "percent" as const,
        }));
        const result = await previewScenario(scenarioId, payload);
        if (id !== requestId.current) return;
        const pl =
          (result.pl as Record<string, number> | undefined) ??
          (result.aggregate as Record<string, number> | undefined) ??
          null;
        setPreviewPl(pl);
        const n = Array.isArray(result.notices)
          ? result.notices.map((x) => (typeof x === "string" ? x : String(x)))
          : [];
        if (n.length) setNotices(n);
      } catch (e) {
        if (id !== requestId.current) return;
        setError((e as Error).message);
      }
      if (id === requestId.current) setPreviewing(false);
    },
    [scenarioId],
  );

  useEffect(() => {
    if (levers.length === 0 || loading) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      runPreview(levers);
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [levers, loading, runPreview]);

  const setDraftPct = (key: string, value: number) => {
    setApplyMsg(null);
    setLevers((prev) => prev.map((l) => (l.key === key ? { ...l, draftPct: value } : l)));
  };

  const handleApply = async () => {
    setApplying(true);
    setError(null);
    setApplyMsg(null);
    try {
      for (const l of levers) {
        if (Math.abs(l.draftPct - (initialPct.current[l.key] ?? 0)) < 1e-6) continue;
        // Always persist as percent against the model input so Approve & Run matches preview
        await applyLeverValue(scenarioId, l.variableId, l.draftPct, {
          delta_type: "percent",
          reason: "live_what_if",
          status: l.parameterId ? "modified" : "pending",
        });
      }
      setApplyMsg("Applied — values saved to scenario parameters (not auto-run). Re-approve & run to persist a simulation.");
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
    setApplying(false);
  };

  const handleReset = () => {
    setLevers((prev) =>
      prev.map((l) => ({ ...l, draftPct: initialPct.current[l.key] ?? 0 })),
    );
    setApplyMsg(null);
  };

  const highlightKeys = [
    "revenue",
    "net_revenue",
    "gross_revenue",
    "net_income",
    "gross_profit",
    "ebitda",
    "operating_income",
    "ebitda_margin",
  ];
  const previewRows = previewPl
    ? Object.entries(previewPl)
        .filter(([k]) => highlightKeys.includes(k) || highlightKeys.some((h) => k.includes(h)))
        .slice(0, 10)
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
        Adjust input levers for a live preview. Sliders are percent change vs model base. Changes are not persisted until you click Apply.
      </p>

      {error && (
        <p className="text-xs text-[var(--danger)] mb-2 bg-[var(--danger-bg)] px-3 py-1.5 rounded-lg">{error}</p>
      )}
      {applyMsg && (
        <p className="text-xs text-[var(--success)] mb-2 bg-[var(--success-bg)] px-3 py-1.5 rounded-lg">{applyMsg}</p>
      )}
      {notices.map((n, i) => (
        <p key={i} className="text-[11px] text-[var(--warning)] bg-[var(--warning-bg)] px-2.5 py-1 rounded-lg mb-1">
          {n}
        </p>
      ))}

      {loading ? (
        <p className="text-xs text-[var(--text-muted)]">Loading levers…</p>
      ) : levers.length === 0 ? (
        <p className="text-xs text-[var(--text-muted)]">
          No model input levers available for what-if. Check that the workbook has bound scenario levers.
        </p>
      ) : (
        <div className="space-y-3 mb-4">
          {levers.map((l) => {
            const min = -50;
            const max = 100;
            return (
              <div
                key={l.key}
                className="rounded-xl border border-[var(--border)] bg-[var(--card-bg)] p-3"
              >
                <div className="flex items-center justify-between gap-2 mb-2">
                  <span className="text-xs font-medium text-[var(--text-primary)]">{l.label}</span>
                  <span className="text-[10px] text-[var(--text-faint)]">
                    {l.variableId} · base {fmtMetric(l.variableId, l.base)} · %
                    {l.source === "model" ? " · model input" : ""}
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  <input
                    type="range"
                    min={min}
                    max={max}
                    step={0.5}
                    value={l.draftPct}
                    onChange={(e) => setDraftPct(l.key, toFiniteNumber(e.target.value))}
                    className="flex-1 accent-[var(--accent,#86BC25)]"
                  />
                  <input
                    type="number"
                    value={l.draftPct}
                    onChange={(e) => setDraftPct(l.key, toFiniteNumber(e.target.value))}
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
            {basePl?.ebitda != null && previewPl?.ebitda != null && basePl.ebitda !== previewPl.ebitda
              ? ` · EBITDA ${fmtMetric("ebitda", basePl.ebitda)} → ${fmtMetric("ebitda", previewPl.ebitda)}`
              : ""}
          </div>
          <table className="w-full text-xs">
            <tbody>
              {previewRows.map(([k, v]) => {
                const base = basePl?.[k];
                const delta = base != null && Number.isFinite(base) ? v - base : null;
                return (
                  <tr key={k} className="border-t border-[var(--border)]">
                    <td className="px-3 py-1.5 text-[var(--text-primary)]">{metricLabel(k)}</td>
                    <td className="px-3 py-1.5 text-right font-medium">{fmtMetric(k, v)}</td>
                    <td className="px-3 py-1.5 text-right text-[10px] text-[var(--text-faint)]">
                      {delta != null && Math.abs(delta) > 1e-9
                        ? `${delta > 0 ? "+" : ""}${fmtMetric(k, delta)}`
                        : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
