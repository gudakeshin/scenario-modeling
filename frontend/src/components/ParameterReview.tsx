"use client";

import { useEffect, useState, useCallback } from "react";
import { PanelHeader } from "./PanelHeader";
import { getParameters, updateParameter, approveScenario, type StoredParameter } from "@/lib/api";

interface ParameterReviewProps {
  scenarioId: string;
  onApproved: () => void;
  onClose: () => void;
  onMinimize?: () => void;
}

export function ParameterReview({ scenarioId, onApproved, onClose, onMinimize }: ParameterReviewProps) {
  const [params, setParams] = useState<StoredParameter[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const p = await getParameters(scenarioId);
      setParams(p);
    } catch (e) {
      setError((e as Error).message);
    }
    setLoading(false);
  }, [scenarioId]);

  useEffect(() => { load(); }, [load]);

  const handleAccept = async (paramId: string) => {
    await updateParameter(scenarioId, paramId, { status: "accepted" });
    load();
  };

  const handleReject = async (paramId: string) => {
    await updateParameter(scenarioId, paramId, { status: "rejected" });
    load();
  };

  const handleValueChange = async (paramId: string, value: number) => {
    await updateParameter(scenarioId, paramId, { scenario_value: value, status: "modified" });
    load();
  };

  const handleApprove = async () => {
    const hasAccepted = params.some((p) => p.status === "accepted" || p.status === "modified");
    if (!hasAccepted) {
      setError("Accept at least one parameter before approving.");
      return;
    }
    try {
      await approveScenario(scenarioId);
      onApproved();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const confidenceColor = (score: number) => {
    if (score >= 0.9) return "text-[var(--success)]";
    if (score >= 0.8) return "text-[var(--warning)]";
    return "text-[var(--danger)]";
  };

  const statusBadge = (status: string) => {
    const colors: Record<string, string> = {
      pending: "bg-deloitte-gray-200 text-deloitte-gray-700",
      accepted: "bg-[var(--success-bg)] text-[var(--success)] border border-[var(--success)]/20",
      rejected: "bg-[var(--danger-bg)] text-[var(--danger)] border border-[var(--danger)]/20",
      modified: "bg-[var(--info-bg)] text-[var(--info)] border border-[var(--info)]/20",
    };
    return (
      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${colors[status] || colors.pending}`}>
        {status}
      </span>
    );
  };

  if (loading) return <div className="p-4 text-sm text-[var(--text-muted)]">Loading parameters...</div>;

  return (
    <div className="border border-[var(--panel-border)] rounded-2xl bg-[var(--card-bg)] p-4 mx-4 mb-3 shadow-panel">
      <PanelHeader
        title="Parameter Review"
        icon={<div className="w-5 h-5 rounded-md bg-accent/10 flex items-center justify-center"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2.5"><path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" /></svg></div>}
        onClose={onClose}
        onMinimize={onMinimize || onClose}
        isMinimized={false}
      />
      {error && <p className="text-xs text-[var(--danger)] mb-2 bg-[var(--danger-bg)] px-3 py-1.5 rounded-lg">{error}</p>}
      <div className="space-y-2">
        {params.map((p) => (
          <div key={p.parameter_id} className="flex items-center gap-3 text-sm border-b border-[var(--border-light)] pb-2 last:border-0">
            <div className="flex-1 min-w-0">
              <p className="font-medium truncate text-[var(--text-primary)]">{p.extracted_name}</p>
              <p className="text-xs text-[var(--text-faint)]">{p.mapped_variable_id}</p>
            </div>
            <input
              type="number"
              defaultValue={p.scenario_value}
              onBlur={(e) => {
                const v = parseFloat(e.target.value);
                if (!isNaN(v) && v !== p.scenario_value) handleValueChange(p.parameter_id, v);
              }}
              className="w-20 rounded-lg border border-[var(--input-border)] bg-[var(--input-bg)] px-2 py-1 text-xs text-center focus:outline-none focus:border-[var(--input-focus-border)] focus:ring-1 focus:ring-accent/20 transition-colors"
            />
            <span className={`text-xs font-mono ${confidenceColor(p.confidence_score)}`}>
              {(p.confidence_score * 100).toFixed(0)}%
            </span>
            {statusBadge(p.status)}
            {p.status !== "accepted" && p.status !== "rejected" && (
              <>
                <button type="button" onClick={() => handleAccept(p.parameter_id)} className="text-xs px-2.5 py-1 rounded-lg bg-[var(--success)] text-white hover:opacity-90 transition-opacity shadow-sm">Accept</button>
                <button type="button" onClick={() => handleReject(p.parameter_id)} className="text-xs px-2.5 py-1 rounded-lg bg-[var(--danger)] text-white hover:opacity-90 transition-opacity shadow-sm">Reject</button>
              </>
            )}
          </div>
        ))}
      </div>
      <div className="mt-4 flex justify-end">
        <button
          type="button"
          onClick={handleApprove}
          className="rounded-xl bg-accent text-white px-5 py-2 text-sm font-medium hover:bg-accent-hover transition-colors shadow-sm"
        >
          Approve &amp; Run
        </button>
      </div>
    </div>
  );
}
