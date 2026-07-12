"use client";

import { useEffect, useMemo, useState } from "react";
import {
  getPlanningModelMetadata,
  listImportSnapshots,
  listPlanningModels,
  refreshImport,
  type ExternalModelSnapshot,
  type PlanningModelMetadata,
  type PlanningModelSummary,
} from "@/lib/api";
import { ImportStatsCard } from "../ImportHistoryPanel";

interface ModelBrowserProps {
  connectionId: string | null;
  connectionName?: string;
  onImport: (modelId: string, modelName: string) => void;
  refreshKey?: number;
}

type ModelRow = PlanningModelSummary & {
  dims?: number;
  measures?: number;
  loadingMeta?: boolean;
};

export function ModelBrowser({
  connectionId,
  connectionName,
  onImport,
  refreshKey = 0,
}: ModelBrowserProps) {
  const [query, setQuery] = useState("");
  const [models, setModels] = useState<ModelRow[]>([]);
  const [snapshots, setSnapshots] = useState<ExternalModelSnapshot[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState<string | null>(null);

  useEffect(() => {
    if (!connectionId) {
      setModels([]);
      setSnapshots([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    Promise.all([
      listPlanningModels(connectionId),
      listImportSnapshots(),
    ])
      .then(async ([modelRes, allSnaps]) => {
        if (cancelled) return;
        setSnapshots(allSnaps.filter((s) => s.connection_id === connectionId));
        const rows: ModelRow[] = modelRes.models.map((m) => ({ ...m, loadingMeta: true }));
        setModels(rows);
        setError(null);
        // Enrich with dim/measure counts (best-effort, parallel)
        await Promise.all(
          modelRes.models.map(async (m) => {
            try {
              const meta: PlanningModelMetadata = await getPlanningModelMetadata(connectionId, m.id);
              if (cancelled) return;
              setModels((prev) =>
                prev.map((row) =>
                  row.id === m.id
                    ? {
                        ...row,
                        dims: meta.dimensions.length,
                        measures: meta.measures.length,
                        loadingMeta: false,
                      }
                    : row,
                ),
              );
            } catch {
              if (cancelled) return;
              setModels((prev) =>
                prev.map((row) => (row.id === m.id ? { ...row, loadingMeta: false } : row)),
              );
            }
          }),
        );
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [connectionId, refreshKey]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return models;
    return models.filter(
      (m) => m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q),
    );
  }, [models, query]);

  const handleRefresh = async (snapshotId: string) => {
    setRefreshing(snapshotId);
    try {
      await refreshImport(snapshotId);
      const all = await listImportSnapshots();
      if (connectionId) setSnapshots(all.filter((s) => s.connection_id === connectionId));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRefreshing(null);
    }
  };

  if (!connectionId) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center">
        <div>
          <p className="text-sm font-medium text-[var(--text-primary)]">Select a connected system</p>
          <p className="mt-1 text-xs text-[var(--text-muted)]">
            Choose a connection on the left, or connect a new system to browse models.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-[var(--border)] px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-[var(--text-primary)]">
            Models{connectionName ? ` in “${connectionName}”` : ""}
          </h2>
        </div>
        <label className="relative block w-48">
          <span className="sr-only">Search models</span>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search…"
            className="w-full rounded-lg border border-[var(--border)] bg-[var(--card-bg)] py-1.5 pl-3 pr-3 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-faint)] outline-none focus:border-accent/40"
          />
        </label>
      </div>

      {error && (
        <p className="mx-4 mt-2 text-xs text-[var(--danger)]">{error}</p>
      )}

      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
        {loading && models.length === 0 && (
          <p className="text-xs text-[var(--text-muted)]">Loading models…</p>
        )}
        {!loading && filtered.length === 0 && (
          <p className="text-xs text-[var(--text-muted)]">No models found.</p>
        )}
        {filtered.map((m) => (
          <div
            key={m.id}
            className="flex items-center justify-between gap-3 rounded-xl border border-[var(--border)] bg-[var(--card-bg)] px-3 py-2.5"
          >
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-[var(--text-primary)]">{m.name}</p>
              <p className="text-[11px] text-[var(--text-muted)]">
                {m.loadingMeta
                  ? "Loading metadata…"
                  : `${m.dims ?? "—"} dims · ${m.measures ?? "—"} measures`}
              </p>
            </div>
            <button
              type="button"
              onClick={() => onImport(m.id, m.name)}
              className="shrink-0 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-[var(--on-accent)] hover:bg-accent-hover"
            >
              Import
            </button>
          </div>
        ))}

        <div className="pt-4">
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
            Import history
          </h3>
          {snapshots.length === 0 && (
            <p className="text-xs text-[var(--text-muted)]">No imports yet for this connection.</p>
          )}
          {snapshots.map((s) => (
            <div
              key={s.snapshot_id}
              className="mb-2 rounded-lg border border-[var(--border)] px-3 py-2 text-xs"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-[var(--text-primary)]">
                  {s.external_model_name}
                  {s.snapshot_version != null ? ` v${s.snapshot_version}` : ""}
                </span>
                <span
                  className={
                    s.status === "ready"
                      ? "text-[var(--success)]"
                      : s.status === "failed"
                        ? "text-[var(--danger)]"
                        : "text-[var(--text-muted)]"
                  }
                >
                  {s.status}
                  {s.status === "ready" ? " ★" : ""}
                </span>
              </div>
              {s.error && <p className="mt-1 text-[var(--danger)]">{s.error}</p>}
              <ImportStatsCard stats={s.stats} />
              {(s.status === "ready" || s.status === "superseded" || s.status === "failed") && (
                <button
                  type="button"
                  disabled={refreshing === s.snapshot_id}
                  onClick={() => handleRefresh(s.snapshot_id)}
                  className="mt-1 text-[11px] font-medium text-[var(--accent-text)] disabled:opacity-40"
                >
                  {refreshing === s.snapshot_id ? "Refreshing…" : "Refresh"}
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
