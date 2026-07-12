"use client";

import { useState, useEffect } from "react";
import { PanelHeader } from "./PanelHeader";
import {
  listConnections,
  listPlanningModels,
  getPlanningModelMetadata,
  importPlanningModel,
  getImportStatus,
  type PlanningConnection,
  type PlanningModelSummary,
  type PlanningModelMetadata,
  type ExternalModelSnapshot,
} from "@/lib/api";
import { ImportStatsCard } from "./ImportHistoryPanel";

interface Props {
  onClose: () => void;
  onMinimize?: () => void;
  initialConnectionId?: string | null;
  onImported?: () => void;
}

type Step = "connection" | "model" | "scope" | "importing";

export function ModelImportWizard({ onClose, onMinimize, initialConnectionId, onImported }: Props) {
  const [step, setStep] = useState<Step>("connection");
  const [connections, setConnections] = useState<PlanningConnection[]>([]);
  const [connectionId, setConnectionId] = useState(initialConnectionId || "");
  const [models, setModels] = useState<PlanningModelSummary[]>([]);
  const [modelId, setModelId] = useState("");
  const [metadata, setMetadata] = useState<PlanningModelMetadata | null>(null);
  const [versionId, setVersionId] = useState("");
  const [timeIds, setTimeIds] = useState<string[]>([]);
  const [status, setStatus] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [snapshotId, setSnapshotId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<ExternalModelSnapshot | null>(null);

  useEffect(() => {
    listConnections()
      .then((r) => {
        setConnections(r.connections);
        if (initialConnectionId) {
          setConnectionId(initialConnectionId);
          setStep("model");
        }
      })
      .catch((e) => setError((e as Error).message));
  }, [initialConnectionId]);

  useEffect(() => {
    if (step !== "model" || !connectionId) return;
    listPlanningModels(connectionId)
      .then((r) => setModels(r.models))
      .catch((e) => setError((e as Error).message));
  }, [step, connectionId]);

  useEffect(() => {
    if (step !== "scope" || !connectionId || !modelId) return;
    getPlanningModelMetadata(connectionId, modelId)
      .then((m) => {
        setMetadata(m);
        const versionDim = m.dimensions.find((d) => d.type === "version");
        const timeDim = m.dimensions.find((d) => d.type === "time");
        if (versionDim?.members[0]) setVersionId(versionDim.members[0].id);
        if (timeDim) {
          setTimeIds(timeDim.members.filter((x) => x.isLeaf).map((x) => x.id));
        }
      })
      .catch((e) => setError((e as Error).message));
  }, [step, connectionId, modelId]);

  useEffect(() => {
    if (!snapshotId || step !== "importing") return;
    let cancelled = false;
    const poll = async () => {
      while (!cancelled) {
        try {
          const snap = await getImportStatus(snapshotId);
          setSnapshot(snap);
          setStatus(snap.status);
          if (snap.status === "ready") {
            onImported?.();
            return;
          }
          if (snap.status === "failed") {
            setError(snap.error || "Import failed");
            return;
          }
        } catch (e) {
          setError((e as Error).message);
          return;
        }
        await new Promise((r) => setTimeout(r, 400));
      }
    };
    void poll();
    return () => {
      cancelled = true;
    };
  }, [snapshotId, step, onImported]);

  const startImport = async () => {
    setError(null);
    if (timeDim && timeIds.length === 0) {
      setError("Select at least one time member before importing.");
      return;
    }
    setStep("importing");
    setStatus("importing");
    try {
      const fact_query: Record<string, unknown> = {};
      if (versionId) fact_query.versionMemberId = versionId;
      if (timeIds.length) fact_query.timeMemberIds = timeIds;
      const { snapshot_id } = await importPlanningModel(connectionId, modelId, fact_query);
      setSnapshotId(snapshot_id);
    } catch (e) {
      setError((e as Error).message);
      setStep("scope");
    }
  };

  const versionDim = metadata?.dimensions.find((d) => d.type === "version");
  const timeDim = metadata?.dimensions.find((d) => d.type === "time");

  return (
    <div className="flex flex-col h-full min-h-0">
      <PanelHeader
        title="Import Planning Model"
        icon={
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
        }
        onClose={onClose}
        onMinimize={onMinimize || onClose}
        isMinimized={false}
      />

      {error && (
        <div className="mx-3 mb-2 text-xs text-[var(--danger)] bg-[var(--danger-bg)] rounded-md px-2 py-1.5">
          {error}
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-3 pb-3 space-y-3">
        <div className="flex gap-2 text-[11px] text-[var(--text-muted)]">
          {(["connection", "model", "scope", "importing"] as Step[]).map((s) => (
            <span key={s} className={step === s ? "text-accent font-semibold" : ""}>
              {s}
            </span>
          ))}
        </div>

        {step === "connection" && (
          <div className="space-y-2">
            <p className="text-xs text-[var(--text-muted)]">Choose a connection</p>
            {connections.map((c) => (
              <button
                key={c.connection_id}
                type="button"
                onClick={() => {
                  setConnectionId(c.connection_id);
                  setStep("model");
                }}
                className="w-full text-left border border-[var(--border)] rounded-lg px-3 py-2 text-sm hover:border-accent"
              >
                {c.name} <span className="text-[11px] text-[var(--text-muted)]">({c.provider})</span>
              </button>
            ))}
            {connections.length === 0 && (
              <p className="text-xs text-[var(--text-muted)]">Add a connection first in Planning Connections.</p>
            )}
          </div>
        )}

        {step === "model" && (
          <div className="space-y-2">
            <button type="button" className="text-[11px] text-accent" onClick={() => setStep("connection")}>
              ← Back
            </button>
            <p className="text-xs text-[var(--text-muted)]">Pick a model</p>
            {models.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => {
                  setModelId(m.id);
                  setStep("scope");
                }}
                className="w-full text-left border border-[var(--border)] rounded-lg px-3 py-2 text-sm hover:border-accent"
              >
                {m.name}
              </button>
            ))}
          </div>
        )}

        {step === "scope" && metadata && (
          <div className="space-y-3">
            <button type="button" className="text-[11px] text-accent" onClick={() => setStep("model")}>
              ← Back
            </button>
            <p className="text-sm font-medium">{metadata.modelName}</p>
            {versionDim && (
              <label className="block text-xs">
                Version
                <select
                  className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--card-bg)] px-2 py-1.5 text-sm"
                  value={versionId}
                  onChange={(e) => setVersionId(e.target.value)}
                >
                  {versionDim.members.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {timeDim && (
              <div className="text-xs">
                <div className="mb-1">Time members ({timeIds.length} selected)</div>
                <div className="max-h-32 overflow-y-auto border border-[var(--border)] rounded-md p-2 space-y-1">
                  {timeDim.members
                    .filter((m) => m.isLeaf)
                    .map((m) => (
                      <label key={m.id} className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={timeIds.includes(m.id)}
                          onChange={(e) => {
                            setTimeIds((prev) =>
                              e.target.checked ? [...prev, m.id] : prev.filter((x) => x !== m.id),
                            );
                          }}
                        />
                        {m.name}
                      </label>
                    ))}
                </div>
              </div>
            )}
            <button
              type="button"
              onClick={startImport}
              disabled={Boolean(timeDim && timeIds.length === 0)}
              className="w-full rounded-md bg-accent text-white text-sm font-medium py-2 disabled:opacity-40"
            >
              Start import
            </button>
            {timeDim && timeIds.length === 0 && (
              <p className="text-[11px] text-[var(--danger)]">Select at least one time member.</p>
            )}
          </div>
        )}

        {step === "importing" && (
          <div className="text-sm space-y-2">
            <p>Status: <span className="font-medium text-accent">{status}</span></p>
            <ImportStatsCard stats={snapshot?.stats} />
            {snapshot?.error && <p className="text-xs text-[var(--danger)]">{snapshot.error}</p>}
            {snapshot?.stats?.errors?.map((message) => (
              <p key={message} className="text-xs text-[var(--danger)]">{message}</p>
            ))}
            {status === "ready" && (
              <p className="text-[var(--success)] text-xs">
                Model imported and activated. You can run dimensional scenarios now.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
