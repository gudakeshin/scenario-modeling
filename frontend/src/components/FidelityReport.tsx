"use client";

import { useState, useCallback } from "react";
import { PanelHeader } from "./PanelHeader";
import { runFidelityAudit, type FidelityAuditResult } from "@/lib/api";

interface FidelityReportProps {
  scenarioId: string;
  onClose: () => void;
  onMinimize?: () => void;
}

export function FidelityReport({ scenarioId, onClose, onMinimize }: FidelityReportProps) {
  const [result, setResult] = useState<FidelityAuditResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setResult(await runFidelityAudit(scenarioId));
    } catch (e) {
      setError((e as Error).message);
    }
    setLoading(false);
  }, [scenarioId]);

  const residual =
    result?.agent.residual_violations ?? result?.deterministic.residual ?? [];

  return (
    <div className="border-t border-[var(--border)] bg-background p-4 max-h-[60vh] overflow-auto">
      <PanelHeader
        title="Accounting Fidelity"
        icon={
          <div className="w-5 h-5 rounded-md bg-[var(--warning-bg)] flex items-center justify-center">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--warning)" strokeWidth="2.5">
              <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" />
            </svg>
          </div>
        }
        onClose={onClose}
        onMinimize={onMinimize ?? onClose}
        isMinimized={false}
      />
      <p className="text-xs text-[var(--text-muted)] mb-3">
        Deterministic invariant check plus gated LLM repairs. Fixes apply only when they tie out.
      </p>
      <button
        type="button"
        onClick={run}
        disabled={loading}
        className="text-xs px-3 py-1.5 rounded-md bg-accent text-white disabled:opacity-50"
      >
        {loading ? "Auditing…" : "Run fidelity audit"}
      </button>
      {error && <p className="text-xs text-[var(--danger)] mt-2">{error}</p>}
      {result && (
        <div className="mt-4 space-y-3 text-xs">
          <div>
            <div className="font-medium text-[var(--text-primary)] mb-1">
              Initial violations ({result.initial_violations.length})
            </div>
            {result.initial_violations.length === 0 ? (
              <p className="text-[var(--text-muted)]">None — P&L already consistent.</p>
            ) : (
              <ul className="space-y-1">
                {result.initial_violations.map((v) => (
                  <li key={v.code + v.metric} className="text-[var(--text-secondary)]">
                    <span className={v.severity === "error" ? "text-[var(--danger)]" : "text-[var(--warning)]"}>
                      [{v.severity}]
                    </span>{" "}
                    {v.message}
                  </li>
                ))}
              </ul>
            )}
          </div>
          {result.deterministic.applied.length > 0 && (
            <div>
              <div className="font-medium text-[var(--text-primary)] mb-1">Deterministic repairs</div>
              <ul className="space-y-1 text-[var(--text-secondary)]">
                {result.deterministic.applied.map((a) => (
                  <li key={a}>• {a}</li>
                ))}
              </ul>
            </div>
          )}
          {result.agent.applied_fixes.length > 0 && (
            <div>
              <div className="font-medium text-[var(--text-primary)] mb-1">Gated LLM fixes applied</div>
              <ul className="space-y-1 text-[var(--text-secondary)]">
                {result.agent.applied_fixes.map((f, i) => (
                  <li key={`${f.metric}-${i}`}>
                    • {f.kind} on {f.metric} — {f.rationale}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {result.agent.proposed_fixes.length > 0 && result.agent.applied_fixes.length === 0 && (
            <div>
              <div className="font-medium text-[var(--text-primary)] mb-1">Proposed (not applied)</div>
              <ul className="space-y-1 text-[var(--text-secondary)]">
                {result.agent.proposed_fixes.map((f, i) => (
                  <li key={`${f.metric}-${i}`}>
                    • {f.kind} on {f.metric} — {f.rationale}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div>
            <div className="font-medium text-[var(--text-primary)] mb-1">
              Residual ({residual.length})
            </div>
            {residual.length === 0 ? (
              <p className="text-[var(--success)]">All invariants satisfied.</p>
            ) : (
              <ul className="space-y-1">
                {residual.map((v) => (
                  <li key={v.code + v.metric} className="text-[var(--text-secondary)]">
                    {v.message}
                  </li>
                ))}
              </ul>
            )}
          </div>
          {result.agent.summary && (
            <p className="text-[var(--text-muted)] italic">{result.agent.summary}</p>
          )}
        </div>
      )}
    </div>
  );
}
