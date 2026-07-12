"use client";

import { useState, useCallback } from "react";
import { PanelHeader } from "./PanelHeader";
import { runGoalSeek, getActiveModel, applyLeverValue, type GoalSeekResult } from "@/lib/api";
import { fmtCurrency } from "@/lib/metrics";

interface GoalSeekViewProps {
  scenarioId: string;
  onClose: () => void;
  onMinimize?: () => void;
}

export function GoalSeekView({ scenarioId, onClose, onMinimize }: GoalSeekViewProps) {
  const [result, setResult] = useState<GoalSeekResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applyMsg, setApplyMsg] = useState<string | null>(null);
  const [variableId, setVariableId] = useState("");
  const [targetMetric, setTargetMetric] = useState("net_income");
  const [targetValue, setTargetValue] = useState("");
  const [leverOptions, setLeverOptions] = useState<Array<{ id: string; name: string }>>([]);

  const loadLevers = useCallback(async () => {
    try {
      const { model } = await getActiveModel();
      const vars = (model?.model_definition?.variables ?? [])
        .filter((v) => !v.dependencies?.length || v.tags?.includes("input"))
        .map((v) => ({ id: v.id, name: v.name || v.id }));
      setLeverOptions(vars);
      if (!variableId && vars[0]) setVariableId(vars[0].id);
    } catch {
      /* model may be xlsx schema — leave blank for manual entry */
    }
  }, [variableId]);

  const run = useCallback(async () => {
    const tv = Number(targetValue);
    if (!Number.isFinite(tv)) {
      setError("Enter a lever and a numeric target value");
      return;
    }
    setLoading(true);
    setError(null);
    setApplyMsg(null);
    try {
      let lever = variableId;
      if (!lever || leverOptions.length === 0) {
        const { model } = await getActiveModel().catch(() => ({ model: null }));
        const vars = (model?.model_definition?.variables ?? [])
          .filter((v) => !v.dependencies?.length || v.tags?.includes("input"))
          .map((v) => ({ id: v.id, name: v.name || v.id }));
        if (vars.length > 0) {
          setLeverOptions(vars);
          if (!lever) {
            lever = vars[0].id;
            setVariableId(lever);
          }
        }
      }
      if (!lever) {
        setError("Enter a lever and a numeric target value");
        setLoading(false);
        return;
      }
      setResult(await runGoalSeek(scenarioId, lever, tv, targetMetric));
    } catch (e) {
      setError((e as Error).message);
    }
    setLoading(false);
  }, [scenarioId, variableId, targetValue, targetMetric, leverOptions.length]);

  const applySolved = useCallback(async () => {
    if (result?.solved_value == null || !result.variable_id) return;
    setApplying(true);
    setError(null);
    setApplyMsg(null);
    try {
      const applied = await applyLeverValue(scenarioId, result.variable_id, result.solved_value, {
        delta_type: "absolute",
        reason: `Goal-seek: hit ${result.target_metric}=${result.target_value}`,
        status: "pending",
      });
      setApplyMsg(
        applied.created
          ? `Created pending parameter for ${applied.mapped_variable_id} — review & approve in Parameter Review.`
          : `Updated parameter for ${applied.mapped_variable_id} — review & approve in Parameter Review.`,
      );
    } catch (e) {
      setError((e as Error).message);
    }
    setApplying(false);
  }, [scenarioId, result]);

  return (
    <div className="border-t border-[var(--border)] bg-background p-4 max-h-[60vh] overflow-auto">
      <PanelHeader
        title="Goal Seek"
        icon={
          <div className="w-5 h-5 rounded-md bg-accent/15 flex items-center justify-center">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-accent">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7v5l3 2" />
            </svg>
          </div>
        }
        onClose={onClose}
        onMinimize={onMinimize || onClose}
        isMinimized={false}
      />

      <p className="text-xs text-[var(--text-muted)] mb-3">
        Solve for a lever value that hits a target P&amp;L metric. Apply writes a pending parameter — approval still required.
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mb-3">
        <label className="text-xs text-[var(--text-secondary)]">
          Lever
          <select
            className="mt-1 w-full text-sm bg-[var(--card-bg)] border border-[var(--border)] rounded px-2 py-1.5"
            value={variableId}
            onFocus={() => { if (leverOptions.length === 0) void loadLevers(); }}
            onChange={(e) => setVariableId(e.target.value)}
          >
            {leverOptions.length === 0 && <option value={variableId || ""}>{variableId || "Enter / load levers…"}</option>}
            {leverOptions.map((v) => (
              <option key={v.id} value={v.id}>{v.name}</option>
            ))}
          </select>
          {leverOptions.length === 0 && (
            <input
              className="mt-1 w-full text-sm bg-[var(--card-bg)] border border-[var(--border)] rounded px-2 py-1.5"
              placeholder="variable_id"
              value={variableId}
              onChange={(e) => setVariableId(e.target.value)}
            />
          )}
        </label>
        <label className="text-xs text-[var(--text-secondary)]">
          Target metric
          <input
            className="mt-1 w-full text-sm bg-[var(--card-bg)] border border-[var(--border)] rounded px-2 py-1.5"
            value={targetMetric}
            onChange={(e) => setTargetMetric(e.target.value)}
          />
        </label>
        <label className="text-xs text-[var(--text-secondary)]">
          Target value
          <input
            className="mt-1 w-full text-sm bg-[var(--card-bg)] border border-[var(--border)] rounded px-2 py-1.5"
            type="number"
            value={targetValue}
            onChange={(e) => setTargetValue(e.target.value)}
          />
        </label>
      </div>

      <button
        type="button"
        onClick={() => void run()}
        disabled={loading}
        className="px-3 py-1.5 text-sm rounded-md bg-accent text-white disabled:opacity-50"
      >
        {loading ? "Solving…" : "Solve"}
      </button>

      {error && <p className="mt-2 text-sm text-[var(--danger)]">{error}</p>}
      {applyMsg && <p className="mt-2 text-sm text-[var(--success)]">{applyMsg}</p>}

      {result && (
        <div className="mt-4 text-sm space-y-1 bg-[var(--card-bg)] border border-[var(--border)] rounded-lg p-3">
          <p>
            <span className="text-[var(--text-muted)]">Status:</span>{" "}
            {result.converged ? (
              <span className="text-[var(--success)]">Converged</span>
            ) : (
              <span className="text-[var(--warning)]">Did not converge</span>
            )}
          </p>
          {result.solved_value != null && (
            <p>
              <span className="text-[var(--text-muted)]">Solved {result.variable_id}:</span>{" "}
              <strong>{result.solved_value.toLocaleString()}</strong>
            </p>
          )}
          {result.achieved_metric != null && (
            <p>
              <span className="text-[var(--text-muted)]">Achieved {result.target_metric}:</span>{" "}
              <strong>{fmtCurrency(result.achieved_metric)}</strong>
              <span className="text-[var(--text-muted)]"> (target {fmtCurrency(result.target_value)})</span>
            </p>
          )}
          <p className="text-xs text-[var(--text-muted)]">
            {result.iterations} iterations · method {(result.diagnostics as { method?: string })?.method ?? "—"}
          </p>
          {!result.converged && (result.diagnostics as { last_error?: number })?.last_error != null && (
            <p className="text-xs text-[var(--warning)]">
              Last residual: {(result.diagnostics as { last_error?: number }).last_error}
            </p>
          )}
          {result.solved_value != null && (
            <button
              type="button"
              onClick={() => void applySolved()}
              disabled={applying}
              className="mt-2 px-3 py-1.5 text-xs rounded-md border border-[var(--border)] bg-[var(--panel-bg)] hover:bg-[var(--card-bg)] disabled:opacity-50"
            >
              {applying ? "Applying…" : "Apply to parameters"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
