"use client";

import { useState, useEffect, useCallback } from "react";
import { PanelHeader } from "./PanelHeader";
import { getAuditTrail, type AuditEntry } from "@/lib/api";
import { formatAuditDetails, formatTouchedLevers } from "@/lib/auditFormat";

interface AuditTrailViewerProps {
  scenarioId?: string;
  onClose: () => void;
  onMinimize?: () => void;
}

const ACTION_LABELS: Record<string, string> = {
  created: "Scenario Created",
  approved: "Approved",
  simulation_run: "Simulation Run",
  parameter_updated: "Parameter Updated",
  shared: "Shared",
};

function formatTime(ts: string) {
  const d = new Date(ts);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function AuditDetailsCell({ details }: { details: Record<string, unknown> | null }) {
  if (!details) return <span className="text-[var(--text-faint)]">{"\u2014"}</span>;

  const rows = formatAuditDetails(details);
  const levers = formatTouchedLevers(details);

  if (rows.length === 0 && levers.length === 0) {
    return <span className="text-[var(--text-faint)]">{"\u2014"}</span>;
  }

  return (
    <div className="space-y-1.5 max-w-md">
      {rows.length > 0 && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-[11px]">
          {rows.map((r) => (
            <div key={r.key} className="contents">
              <dt className="font-medium text-[var(--text-secondary)] whitespace-nowrap">{r.key}</dt>
              <dd className="text-[var(--text-muted)] break-words">{r.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {levers.length > 0 && (
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-faint)] mb-0.5">
            Touched levers
          </p>
          <ul className="list-disc list-inside text-[11px] text-[var(--text-muted)] space-y-0.5">
            {levers.slice(0, 8).map((l, i) => (
              <li key={i}>{l}</li>
            ))}
            {levers.length > 8 && (
              <li className="text-[var(--text-faint)]">+{levers.length - 8} more</li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

export function AuditTrailViewer({ scenarioId, onClose, onMinimize }: AuditTrailViewerProps) {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 20;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getAuditTrail({ scenario_id: scenarioId, limit: PAGE_SIZE, offset: page * PAGE_SIZE });
      setEntries(data.entries);
      setTotal(data.total);
    } catch {
      // ignore
    }
    setLoading(false);
  }, [scenarioId, page]);

  useEffect(() => { load(); }, [load]);

  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <div className="border-t border-[var(--border)] bg-background p-4 max-h-[50vh] overflow-auto">
      <PanelHeader
        title={<>Audit Trail {scenarioId ? "(Scenario)" : "(All)"}</>}
        icon={<div className="w-5 h-5 rounded-md bg-deloitte-gray-200 flex items-center justify-center"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2.5"><path d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg></div>}
        onClose={onClose}
        onMinimize={onMinimize || onClose}
        isMinimized={false}
      />
      {loading ? (
        <p className="text-xs text-[var(--text-faint)]">Loading...</p>
      ) : entries.length === 0 ? (
        <p className="text-xs text-[var(--text-faint)]">No audit entries found.</p>
      ) : (
        <>
          <div className="rounded-xl border border-[var(--card-border)] overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-[var(--panel-bg)]">
                  <th className="py-2 px-3 text-left font-medium text-[var(--text-secondary)]">Action</th>
                  <th className="py-2 px-3 text-left font-medium text-[var(--text-secondary)]">Details</th>
                  <th className="py-2 px-3 text-left font-medium text-[var(--text-secondary)]">Time</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.audit_id} className="border-t border-[var(--border-light)] hover:bg-[var(--panel-bg)] transition-colors align-top">
                    <td className="py-2 px-3 font-medium text-[var(--text-primary)]">
                      {ACTION_LABELS[e.action_type] || e.action_type}
                    </td>
                    <td className="py-2 px-3">
                      <AuditDetailsCell details={e.action_details} />
                    </td>
                    <td className="py-2 px-3 text-[var(--text-faint)] whitespace-nowrap">{formatTime(e.timestamp)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-between mt-3 text-xs">
              <button
                disabled={page === 0}
                onClick={() => setPage((p) => p - 1)}
                className="px-3 py-1.5 rounded-lg border border-[var(--border)] text-[var(--text-secondary)] disabled:opacity-30 hover:bg-[var(--panel-bg)] transition-colors"
              >
                Prev
              </button>
              <span className="text-[var(--text-faint)]">
                Page {page + 1} of {totalPages} ({total} entries)
              </span>
              <button
                disabled={page >= totalPages - 1}
                onClick={() => setPage((p) => p + 1)}
                className="px-3 py-1.5 rounded-lg border border-[var(--border)] text-[var(--text-secondary)] disabled:opacity-30 hover:bg-[var(--panel-bg)] transition-colors"
              >
                Next
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
