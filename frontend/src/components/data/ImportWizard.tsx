"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  cancelImport,
  getActiveModel,
  getImportStatus,
  getModelMappingPreview,
  getPlanningModelMetadata,
  importPlanningModel,
  type ExternalModelSnapshot,
  type MappingPreview,
  type PlanningModelMetadata,
} from "@/lib/api";
import { ImportStatsCard } from "../ImportHistoryPanel";
import { Stepper } from "./Stepper";

export const EXTERNAL_MODEL_MAX_CELLS = 500_000;

const STEPS = [
  { id: "scope", label: "Scope" },
  { id: "review", label: "Review" },
  { id: "importing", label: "Importing" },
  { id: "done", label: "Done" },
] as const;

type StepId = (typeof STEPS)[number]["id"];

interface ImportWizardProps {
  open: boolean;
  connectionId: string;
  modelId: string;
  modelName: string;
  onClose: () => void;
  onComplete: () => void;
}

function estimateCells(
  meta: PlanningModelMetadata,
  timeIds: string[],
  measureIds: string[],
): number {
  const timeDim = meta.dimensions.find((d) => d.type === "time");
  const versionDim = meta.dimensions.find((d) => d.type === "version");
  const otherDims = meta.dimensions.filter(
    (d) => d.type !== "time" && d.type !== "version",
  );
  const timeCount = timeDim ? Math.max(timeIds.length, 1) : 1;
  const versionCount = versionDim ? 1 : 1;
  const otherProduct = otherDims.reduce((acc, d) => {
    const leaves = d.members.filter((m) => m.isLeaf).length || d.members.length || 1;
    return acc * Math.max(leaves, 1);
  }, 1);
  const measureCount = Math.max(measureIds.length, 1);
  return timeCount * versionCount * otherProduct * measureCount;
}

export function ImportWizard({
  open,
  connectionId,
  modelId,
  modelName,
  onClose,
  onComplete,
}: ImportWizardProps) {
  const [step, setStep] = useState<StepId>("scope");
  const [metadata, setMetadata] = useState<PlanningModelMetadata | null>(null);
  const [mapping, setMapping] = useState<MappingPreview | null>(null);
  const [activeModelName, setActiveModelName] = useState<string | null>(null);
  const [versionId, setVersionId] = useState("");
  const [timeIds, setTimeIds] = useState<string[]>([]);
  const [measureIds, setMeasureIds] = useState<string[]>([]);
  const [replaceConfirmed, setReplaceConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [snapshotId, setSnapshotId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<ExternalModelSnapshot | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [cancelling, setCancelling] = useState(false);

  useEffect(() => {
    if (!open) return;
    setStep("scope");
    setError(null);
    setSnapshotId(null);
    setSnapshot(null);
    setReplaceConfirmed(false);
    setMapping(null);
    setStartedAt(null);
    getActiveModel()
      .then((r) => setActiveModelName(r.model?.name ?? null))
      .catch(() => setActiveModelName(null));
    getPlanningModelMetadata(connectionId, modelId)
      .then((m) => {
        setMetadata(m);
        const versionDim = m.dimensions.find((d) => d.type === "version");
        const timeDim = m.dimensions.find((d) => d.type === "time");
        if (versionDim?.members[0]) setVersionId(versionDim.members[0].id);
        if (timeDim) setTimeIds(timeDim.members.filter((x) => x.isLeaf).map((x) => x.id));
        setMeasureIds(m.measures.map((x) => x.id));
      })
      .catch((e) => setError((e as Error).message));
  }, [open, connectionId, modelId]);

  useEffect(() => {
    if (!open || step !== "review") return;
    getModelMappingPreview(connectionId, modelId)
      .then(setMapping)
      .catch((e) => setError((e as Error).message));
  }, [open, step, connectionId, modelId]);

  useEffect(() => {
    if (!snapshotId || step !== "importing") return;
    let cancelled = false;
    const poll = async () => {
      while (!cancelled) {
        try {
          const snap = await getImportStatus(snapshotId);
          setSnapshot(snap);
          if (snap.status === "ready") {
            setStep("done");
            onComplete();
            return;
          }
          if (snap.status === "failed") {
            const msg = snap.error || "Import failed";
            setError(msg);
            if (/cancel/i.test(msg)) {
              setStep("review");
            }
            return;
          }
        } catch (e) {
          setError((e as Error).message);
          return;
        }
        await new Promise((r) => setTimeout(r, 800));
      }
    };
    void poll();
    return () => {
      cancelled = true;
    };
  }, [snapshotId, step, onComplete]);

  useEffect(() => {
    if (step !== "importing" || !startedAt) return;
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 500);
    return () => clearInterval(t);
  }, [step, startedAt]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && step !== "importing") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, step]);

  const versionDim = metadata?.dimensions.find((d) => d.type === "version");
  const timeDim = metadata?.dimensions.find((d) => d.type === "time");
  const leafTimes = timeDim?.members.filter((m) => m.isLeaf) ?? [];

  const estimate = useMemo(() => {
    if (!metadata) return 0;
    return estimateCells(metadata, timeIds, measureIds);
  }, [metadata, timeIds, measureIds]);

  const nearCap = estimate >= EXTERNAL_MODEL_MAX_CELLS * 0.8;
  const overCap = estimate > EXTERNAL_MODEL_MAX_CELLS;

  const completed = STEPS.filter((s) => {
    const order = STEPS.map((x) => x.id);
    return order.indexOf(s.id) < order.indexOf(step);
  }).map((s) => s.id);

  const startImport = async () => {
    if (timeDim && timeIds.length === 0) {
      setError("Select at least one time member.");
      return;
    }
    if (activeModelName && !replaceConfirmed) {
      setError("Confirm replacing the active model to continue.");
      return;
    }
    if (overCap) {
      setError(`Estimated ${estimate.toLocaleString()} cells exceeds the ${EXTERNAL_MODEL_MAX_CELLS.toLocaleString()} limit. Narrow scope.`);
      return;
    }
    setError(null);
    setStep("importing");
    setStartedAt(Date.now());
    setElapsed(0);
    try {
      const fact_query: Record<string, unknown> = {};
      if (versionId) fact_query.versionMemberId = versionId;
      if (timeIds.length) fact_query.timeMemberIds = timeIds;
      if (measureIds.length && metadata && measureIds.length < metadata.measures.length) {
        fact_query.measureIds = measureIds;
      }
      const { snapshot_id } = await importPlanningModel(connectionId, modelId, fact_query);
      setSnapshotId(snapshot_id);
    } catch (e) {
      setError((e as Error).message);
      setStep("review");
    }
  };

  const handleCancel = async () => {
    if (!snapshotId) return;
    setCancelling(true);
    try {
      await cancelImport(snapshotId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCancelling(false);
    }
  };

  if (!open) return null;

  const progress = snapshot?.stats?.progress;
  const phase = progress?.phase || (snapshot?.status === "importing" ? "Importing…" : snapshot?.status || "…");
  const cells = progress?.cells ?? snapshot?.stats?.fact_count ?? 0;
  const pct = Math.min(95, estimate > 0 ? Math.round((cells / estimate) * 100) : cells > 0 ? 40 : 10);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/30" onClick={step === "importing" ? undefined : onClose} aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Import model"
        className="relative z-10 flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--card-bg)] shadow-2xl"
      >
        <header className="flex items-center justify-between border-b border-[var(--border)] px-5 py-3">
          <div>
            <h2 className="text-base font-semibold text-[var(--text-primary)]">Import {modelName}</h2>
            <p className="text-[11px] text-[var(--text-muted)]">Scope → Review → Import → Activate</p>
          </div>
          {step !== "importing" && (
            <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-[var(--text-muted)] hover:bg-[var(--panel-bg)]" aria-label="Close">
              ✕
            </button>
          )}
        </header>

        <div className="border-b border-[var(--border)] px-5 py-3">
          <Stepper steps={[...STEPS]} current={step} completed={completed} />
        </div>

        {error && (
          <div className="mx-5 mt-3 rounded-lg bg-[var(--danger-bg)] px-3 py-2 text-xs text-[var(--danger)]">
            {error}
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {step === "scope" && metadata && (
            <>
              {versionDim && (
                <label className="block text-xs font-medium text-[var(--text-primary)]">
                  Version
                  <select
                    className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--card-bg)] px-3 py-2 text-sm text-[var(--text-primary)]"
                    value={versionId}
                    onChange={(e) => setVersionId(e.target.value)}
                  >
                    {versionDim.members.map((m) => (
                      <option key={m.id} value={m.id}>{m.name}</option>
                    ))}
                  </select>
                </label>
              )}

              {timeDim && (
                <div>
                  <div className="mb-1 flex items-center justify-between text-xs font-medium text-[var(--text-primary)]">
                    <span>Time members ({timeIds.length} selected)</span>
                    <span className="flex gap-2">
                      <button type="button" className="text-[var(--accent-text)]" onClick={() => setTimeIds(leafTimes.map((m) => m.id))}>
                        Select all
                      </button>
                      <button type="button" className="text-[var(--text-muted)]" onClick={() => setTimeIds([])}>
                        Clear
                      </button>
                    </span>
                  </div>
                  <div className="max-h-40 overflow-y-auto rounded-lg border border-[var(--border)] p-2 space-y-1">
                    {leafTimes.map((m) => (
                      <label key={m.id} className="flex items-center gap-2 text-xs text-[var(--text-primary)]">
                        <input
                          type="checkbox"
                          checked={timeIds.includes(m.id)}
                          onChange={(e) =>
                            setTimeIds((prev) =>
                              e.target.checked ? [...prev, m.id] : prev.filter((x) => x !== m.id),
                            )
                          }
                        />
                        {m.name}
                      </label>
                    ))}
                  </div>
                </div>
              )}

              <div>
                <div className="mb-1 flex items-center justify-between text-xs font-medium text-[var(--text-primary)]">
                  <span>Measures ({measureIds.length} selected)</span>
                  <span className="flex gap-2">
                    <button
                      type="button"
                      className="text-[var(--accent-text)]"
                      onClick={() => setMeasureIds(metadata.measures.map((m) => m.id))}
                    >
                      Select all
                    </button>
                    <button type="button" className="text-[var(--text-muted)]" onClick={() => setMeasureIds([])}>
                      Clear
                    </button>
                  </span>
                </div>
                <div className="max-h-32 overflow-y-auto rounded-lg border border-[var(--border)] p-2 space-y-1">
                  {metadata.measures.map((m) => (
                    <label key={m.id} className="flex items-center gap-2 text-xs text-[var(--text-primary)]">
                      <input
                        type="checkbox"
                        checked={measureIds.includes(m.id)}
                        onChange={(e) =>
                          setMeasureIds((prev) =>
                            e.target.checked ? [...prev, m.id] : prev.filter((x) => x !== m.id),
                          )
                        }
                      />
                      {m.name}
                    </label>
                  ))}
                </div>
              </div>

              <div
                className={`rounded-xl px-3 py-2 text-xs ${
                  overCap
                    ? "bg-[var(--danger-bg)] text-[var(--danger)]"
                    : nearCap
                      ? "bg-[var(--warning-bg)] text-[var(--warning)]"
                      : "bg-[var(--panel-bg)] text-[var(--text-secondary)]"
                }`}
              >
                Estimated cells: <strong>{estimate.toLocaleString()}</strong>
                {" · "}cap {EXTERNAL_MODEL_MAX_CELLS.toLocaleString()}
                {(nearCap || overCap) && " — narrow time or measures before importing."}
              </div>

              <button
                type="button"
                disabled={Boolean(timeDim && timeIds.length === 0) || measureIds.length === 0 || overCap}
                onClick={() => setStep("review")}
                className="w-full rounded-xl bg-accent py-2.5 text-sm font-medium text-[var(--on-accent)] disabled:opacity-40"
              >
                Continue to review
              </button>
            </>
          )}

          {step === "review" && (
            <>
              <div className="rounded-xl border border-[var(--border)] bg-[var(--panel-bg)] p-3 text-sm text-[var(--text-primary)] space-y-1">
                <p><span className="text-[var(--text-muted)]">Model:</span> {modelName}</p>
                {versionId && <p><span className="text-[var(--text-muted)]">Version:</span> {versionId}</p>}
                <p>
                  <span className="text-[var(--text-muted)]">Scope:</span>{" "}
                  {timeIds.length} time × {measureIds.length} measures ≈ {estimate.toLocaleString()} cells
                </p>
              </div>

              {activeModelName && (
                <div className="rounded-xl border border-[var(--warning)]/40 bg-[var(--warning-bg)] p-3">
                  <p className="text-sm font-semibold text-[var(--warning)]">
                    This will replace your active model “{activeModelName}”.
                  </p>
                  <label className="mt-2 flex items-center gap-2 text-xs text-[var(--text-primary)]">
                    <input
                      type="checkbox"
                      checked={replaceConfirmed}
                      onChange={(e) => setReplaceConfirmed(e.target.checked)}
                    />
                    I understand and want to continue
                  </label>
                </div>
              )}

              {mapping && (
                <div>
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                    Measure mapping preview
                  </h3>
                  <ul className="max-h-40 space-y-1 overflow-y-auto text-xs">
                    {mapping.measures.map((m) => (
                      <li key={m.id} className="flex justify-between gap-2 rounded-lg border border-[var(--border)] px-2 py-1.5 text-[var(--text-primary)]">
                        <span>{m.name}</span>
                        <span className="text-[var(--text-muted)] shrink-0">
                          {m.role === "input"
                            ? "direct input"
                            : m.role === "formula_exposed"
                              ? "source formula"
                              : "formula derived on import"}
                        </span>
                      </li>
                    ))}
                  </ul>
                  {mapping.notes.map((n) => (
                    <p key={n} className="mt-1 text-[11px] text-[var(--text-muted)]">{n}</p>
                  ))}
                </div>
              )}

              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setStep("scope")}
                  className="rounded-xl border border-[var(--border)] px-4 py-2 text-sm text-[var(--text-secondary)]"
                >
                  Back
                </button>
                <button
                  type="button"
                  onClick={startImport}
                  disabled={Boolean(activeModelName && !replaceConfirmed)}
                  className="flex-1 rounded-xl bg-accent py-2 text-sm font-medium text-[var(--on-accent)] disabled:opacity-40"
                >
                  Start import
                </button>
              </div>
            </>
          )}

          {step === "importing" && (
            <div className="space-y-3">
              <p className="text-sm font-medium text-[var(--text-primary)]">{phase}</p>
              <div className="h-2 overflow-hidden rounded-full bg-[var(--panel-bg)]">
                <div
                  className="h-full rounded-full bg-accent transition-all duration-500"
                  style={{ width: `${snapshot?.status === "ready" ? 100 : pct}%` }}
                />
              </div>
              <div className="flex justify-between text-[11px] text-[var(--text-muted)]">
                <span>{cells.toLocaleString()} cells</span>
                <span>{elapsed}s elapsed</span>
              </div>
              <ImportStatsCard stats={snapshot?.stats} />
              <button
                type="button"
                onClick={handleCancel}
                disabled={cancelling}
                className="rounded-xl border border-[var(--danger)]/40 px-4 py-2 text-sm font-medium text-[var(--danger)] disabled:opacity-40"
              >
                {cancelling ? "Cancelling…" : "Cancel import"}
              </button>
            </div>
          )}

          {step === "done" && (
            <div className="space-y-3">
              <p className="text-sm font-semibold text-[var(--success)]">Import complete — model activated.</p>
              <ImportStatsCard stats={snapshot?.stats} />
              {snapshot?.stats?.warnings?.map((w) => (
                <p key={w} className="text-xs text-[var(--warning)]">{w}</p>
              ))}
              <Link
                href="/"
                className="inline-flex w-full items-center justify-center rounded-xl bg-accent py-2.5 text-sm font-medium text-[var(--on-accent)] hover:bg-accent-hover"
              >
                Run a scenario
              </Link>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
