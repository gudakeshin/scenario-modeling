"use client";

import { useCallback, useEffect, useState } from "react";
import { PanelHeader } from "./PanelHeader";
import {
  acknowledgeDataQualityFinding,
  getDataQuality,
  type DataQualityFinding,
  type DataQualityReport,
} from "@/lib/api";

interface DataQualityPanelProps {
  onClose: () => void;
  onMinimize?: () => void;
  /** Called after a decision, so callers can re-check whether the model is runnable. */
  onResolved?: (report: DataQualityReport) => void;
}

const CODE_LABELS: Record<string, string> = {
  period_outlier: "Outlier period",
  cached_formula_error: "Formula error in source",
  series_gap: "Gap in series",
  hardcoded_plug: "Hardcoded value",
  calendar_mismatch: "Calendar mismatch",
  inert_assumption: "Assumption drives nothing",
};

function SeverityChip({ severity }: { severity: DataQualityFinding["severity"] }) {
  const isError = severity === "error";
  return (
    <span
      className={
        "text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded border " +
        (isError
          ? "text-[var(--danger)] border-[var(--danger)]/30 bg-[var(--danger-bg)]"
          : "text-[var(--warning)] border-[var(--warning)]/30 bg-[var(--warning-bg)]")
      }
    >
      {isError ? "Blocks run" : "Review"}
    </span>
  );
}

function FindingCard({
  finding,
  onAcknowledge,
  busy,
}: {
  finding: DataQualityFinding;
  onAcknowledge: (note: string) => Promise<void>;
  busy: boolean;
}) {
  const [note, setNote] = useState("");
  const acknowledged = finding.status === "acknowledged";

  return (
    <li className="border border-[var(--card-border)] rounded-lg p-3 space-y-2 bg-[var(--card-bg)]">
      <div className="flex items-start justify-between gap-2">
        <div className="space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            <SeverityChip severity={finding.severity} />
            <span className="text-xs font-medium text-[var(--text-primary)]">
              {CODE_LABELS[finding.code] ?? finding.code}
            </span>
            <span className="text-[11px] text-[var(--text-muted)] font-mono">
              {finding.sheet}
              {finding.cells.length > 0 ? `!${finding.cells.join(", ")}` : ""}
            </span>
          </div>
          <p className="text-xs text-[var(--text-secondary)] leading-relaxed">{finding.message}</p>
        </div>
      </div>

      {acknowledged ? (
        <p className="text-[11px] text-[var(--success)]">
          Accepted{finding.note ? `: “${finding.note}”` : ""}
        </p>
      ) : (
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Why is this acceptable? (recorded with every result)"
            aria-label={`Reason for accepting ${finding.title}`}
            className="flex-1 text-xs px-2 py-1.5 rounded border border-[var(--input-border)] bg-[var(--input-bg)] text-[var(--text-primary)]"
          />
          <button
            type="button"
            disabled={busy || note.trim().length === 0}
            onClick={() => onAcknowledge(note.trim())}
            className="text-xs px-3 py-1.5 rounded bg-[var(--accent)] text-[var(--accent-fg)] disabled:opacity-40"
          >
            Accept
          </button>
        </div>
      )}
    </li>
  );
}

/**
 * The findings themselves, without panel chrome — so the same list can be shown
 * inline where a workbook is uploaded and in the standalone panel.
 */
export function DataQualityFindings({ onResolved }: { onResolved?: (r: DataQualityReport) => void }) {
  const [report, setReport] = useState<DataQualityReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setReport(await getDataQuality());
    } catch (e) {
      setError((e as Error).message);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const acknowledge = useCallback(
    async (findingKey: string, note: string) => {
      setBusyKey(findingKey);
      try {
        await acknowledgeDataQualityFinding(findingKey, note);
        const refreshed = await getDataQuality();
        setReport(refreshed);
        onResolved?.(refreshed);
      } catch (e) {
        setError((e as Error).message);
      }
      setBusyKey(null);
    },
    [onResolved],
  );

  const blocking = report?.blocking ?? [];
  const others = (report?.findings ?? []).filter(
    (f) => !blocking.some((b) => b.findingKey === f.findingKey),
  );

  return (
    <div className="space-y-4">
      {loading && <p className="text-xs text-[var(--text-muted)]">Checking the uploaded data…</p>}
      {error && <p className="text-xs text-[var(--danger)]">{error}</p>}

      {report && report.counts.total === 0 && (
        <p className="text-xs text-[var(--success)]">No data issues found in this workbook.</p>
      )}

      {blocking.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-xs font-semibold text-[var(--text-primary)]">
            Needs a decision before this model can run ({blocking.length})
          </h3>
          <p className="text-[11px] text-[var(--text-muted)]">
            These are values in your uploaded file, not results the system produced.
            Accepting one records your reason alongside every scenario built on it.
          </p>
          <ul className="space-y-2">
            {blocking.map((f) => (
              <FindingCard
                key={f.findingKey}
                finding={f}
                busy={busyKey === f.findingKey}
                onAcknowledge={(note) => acknowledge(f.findingKey, note)}
              />
            ))}
          </ul>
        </section>
      )}

      {others.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-xs font-semibold text-[var(--text-primary)]">
            Worth knowing ({others.length})
          </h3>
          <ul className="space-y-2">
            {others.map((f) => (
              <FindingCard
                key={f.findingKey}
                finding={f}
                busy={busyKey === f.findingKey}
                onAcknowledge={(note) => acknowledge(f.findingKey, note)}
              />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/**
 * Data issues found in the uploaded workbook, surfaced before any scenario is
 * run. Accepting one does not change a number — the workbook stays the source
 * of truth — it records who decided the result could be trusted anyway.
 */
export function DataQualityPanel({ onClose, onMinimize, onResolved }: DataQualityPanelProps) {
  return (
    <div className="flex flex-col h-full">
      <PanelHeader
        title="Data Quality"
        icon={<span aria-hidden>🔍</span>}
        onClose={onClose}
        onMinimize={onMinimize ?? (() => {})}
        isMinimized={false}
      />
      <div className="flex-1 overflow-auto p-4">
        <DataQualityFindings onResolved={onResolved} />
      </div>
    </div>
  );
}
