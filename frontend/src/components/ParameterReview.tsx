"use client";

import { useEffect, useState, useCallback } from "react";
import { PanelHeader } from "./PanelHeader";
import {
  getParameters,
  updateParameter,
  approveScenario,
  getScenarioContext,
  lockScenarioLever,
  resetScenarioUnlockedLevers,
  type StoredParameter,
  type TouchedLever,
} from "@/lib/api";
import type { MemberCatalog } from "@/lib/api";
import { getMemberName } from "@/lib/dimensionalPov";

interface ParameterReviewProps {
  scenarioId: string;
  onApproved: () => void;
  onClose: () => void;
  onMinimize?: () => void;
}

export function ScopeBadge({
  memberScope,
  memberCatalog,
}: {
  memberScope?: Record<string, string> | null;
  memberCatalog?: MemberCatalog;
}) {
  if (!memberScope || Object.keys(memberScope).length === 0) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-1" aria-label="Member scope">
      {Object.entries(memberScope).map(([dimensionId, memberId]) => (
        <span
          key={dimensionId}
          className="rounded-full border border-accent/20 bg-accent/10 px-2 py-0.5 text-[10px] text-accent"
          title={`${dimensionId}: ${memberId}`}
        >
          {dimensionId}: {getMemberName(memberCatalog, dimensionId, memberId)}
        </span>
      ))}
    </div>
  );
}

export function ParameterReview({ scenarioId, onApproved, onClose, onMinimize }: ParameterReviewProps) {
  const [params, setParams] = useState<StoredParameter[]>([]);
  const [touchedLevers, setTouchedLevers] = useState<TouchedLever[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [p, ctx] = await Promise.all([
        getParameters(scenarioId),
        getScenarioContext(scenarioId).catch(() => null),
      ]);
      setParams(p);
      setTouchedLevers(ctx?.context?.touchedLevers ?? []);
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

  const handleAssumptionChange = async (
    paramId: string,
    updates: Parameters<typeof updateParameter>[2],
  ) => {
    try {
      await updateParameter(scenarioId, paramId, updates);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const handleLockToggle = async (leverId: string, locked: boolean) => {
    try {
      const res = await lockScenarioLever(scenarioId, leverId, locked);
      setTouchedLevers(res.context.touchedLevers);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const handleResetUnlocked = async () => {
    try {
      const res = await resetScenarioUnlockedLevers(scenarioId);
      setTouchedLevers(res.context.touchedLevers);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
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

      {touchedLevers.length > 0 && (
        <div className="mb-3 rounded-xl border border-[var(--border-light)] bg-[var(--panel-bg)] p-3">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-wider text-[var(--text-secondary)]">
              Touched levers ({touchedLevers.length})
            </p>
            <button
              type="button"
              onClick={handleResetUnlocked}
              className="text-[11px] text-[var(--text-faint)] hover:text-[var(--danger)]"
              title="Clear unlocked levers"
            >
              Reset unlocked
            </button>
          </div>
          <ul className="space-y-1.5">
            {touchedLevers.map((lever) => (
              <li
                key={lever.id}
                className="flex items-center gap-2 text-xs text-[var(--text-primary)]"
              >
                <span className="min-w-0 flex-1 truncate font-medium">{lever.id}</span>
                <span className="font-mono text-[var(--text-secondary)]">{lever.userValue}</span>
                <button
                  type="button"
                  onClick={() => handleLockToggle(lever.id, !lever.locked)}
                  className={`rounded px-2 py-0.5 text-[10px] font-medium ${
                    lever.locked
                      ? "bg-accent/15 text-accent"
                      : "bg-[var(--border-light)] text-[var(--text-faint)] hover:text-[var(--text-secondary)]"
                  }`}
                  title={lever.locked ? "Unlock lever" : "Lock lever (survives reset)"}
                >
                  {lever.locked ? "Locked" : "Lock"}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="space-y-2">
        {params.map((p) => (
          <div key={p.parameter_id} className="text-sm border-b border-[var(--border-light)] pb-3 last:border-0">
            <div className="flex items-center gap-3">
              <div className="flex-1 min-w-0">
              <p className="font-medium truncate text-[var(--text-primary)]">{p.extracted_name}</p>
              <p className="text-xs text-[var(--text-faint)]">{p.mapped_variable_id}</p>
              <ScopeBadge memberScope={p.member_scope} memberCatalog={p.member_catalog} />
              {p.binding_evidence && (
                <p className="mt-1 text-[11px] text-[var(--text-secondary)] leading-snug">
                  {p.extracted_name} → &apos;{p.binding_evidence.rowLabel}&apos; at{" "}
                  {p.binding_evidence.sheet}!{p.binding_evidence.cell}, base{" "}
                  {p.binding_evidence.base}
                  {p.binding_evidence.affectedOutputs?.length
                    ? ` · moves ${p.binding_evidence.affectedOutputs
                        .slice(0, 3)
                        .map((o) => `${o.label} (${o.direction})`)
                        .join(", ")}`
                    : ""}
                  {(p.needs_review || p.binding_evidence.needsReview) && (
                    <span className="ml-1 text-[var(--warning)]">
                      · needs review
                      {p.binding_evidence.reviewReason
                        ? ` (${p.binding_evidence.reviewReason})`
                        : ""}
                    </span>
                  )}
                </p>
              )}
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
            <details className="mt-2">
              <summary className="cursor-pointer text-[11px] font-medium text-[var(--text-secondary)]">
                Assumption sign-off details
              </summary>
              <div className="mt-2 grid gap-2 md:grid-cols-2">
                <input
                  aria-label="Assumption owner user ID"
                  defaultValue={p.owner_user_id ?? ""}
                  placeholder="Owner user UUID"
                  onBlur={(e) =>
                    handleAssumptionChange(p.parameter_id, {
                      owner_user_id: e.target.value.trim() || null,
                    })
                  }
                  className="rounded-lg border border-[var(--input-border)] bg-[var(--input-bg)] px-2 py-1.5 text-xs"
                />
                <input
                  type="date"
                  aria-label="Effective date"
                  defaultValue={p.effective_from?.slice(0, 10) ?? ""}
                  onBlur={(e) =>
                    handleAssumptionChange(p.parameter_id, {
                      effective_from: e.target.value || null,
                    })
                  }
                  className="rounded-lg border border-[var(--input-border)] bg-[var(--input-bg)] px-2 py-1.5 text-xs"
                />
                <input
                  aria-label="Source citation"
                  defaultValue={p.source_citation ?? ""}
                  placeholder="Source / citation"
                  onBlur={(e) =>
                    handleAssumptionChange(p.parameter_id, {
                      source_citation: e.target.value.trim() || null,
                    })
                  }
                  className="rounded-lg border border-[var(--input-border)] bg-[var(--input-bg)] px-2 py-1.5 text-xs"
                />
                <select
                  aria-label="Review status"
                  defaultValue={p.review_status ?? "draft"}
                  onChange={(e) =>
                    handleAssumptionChange(p.parameter_id, {
                      review_status: e.target.value as NonNullable<StoredParameter["review_status"]>,
                    })
                  }
                  className="rounded-lg border border-[var(--input-border)] bg-[var(--input-bg)] px-2 py-1.5 text-xs"
                >
                  <option value="draft">Draft</option>
                  <option value="reviewed">Reviewed</option>
                  <option value="approved">Approved</option>
                  <option value="rejected">Rejected</option>
                </select>
                <textarea
                  aria-label="Assumption rationale"
                  defaultValue={p.rationale ?? ""}
                  placeholder="Rationale"
                  rows={2}
                  onBlur={(e) =>
                    handleAssumptionChange(p.parameter_id, {
                      rationale: e.target.value.trim() || null,
                    })
                  }
                  className="rounded-lg border border-[var(--input-border)] bg-[var(--input-bg)] px-2 py-1.5 text-xs md:col-span-2"
                />
              </div>
            </details>
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
