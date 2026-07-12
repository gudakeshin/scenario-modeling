"use client";

import { useCallback, useEffect, useState } from "react";
import {
  getActiveModel,
  listImportSnapshots,
  refreshImport,
  type ExternalModelSnapshot,
  type UserModel,
} from "@/lib/api";

function relativeTime(iso: string | undefined): string {
  if (!iso) return "unknown";
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  return `${Math.floor(diff / 86400_000)}d ago`;
}

interface ActiveModelBannerProps {
  refreshKey?: number;
  onShowHistory?: () => void;
}

export function ActiveModelBanner({ refreshKey = 0, onShowHistory }: ActiveModelBannerProps) {
  const [model, setModel] = useState<UserModel | null>(null);
  const [snapshot, setSnapshot] = useState<ExternalModelSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [{ model: active }, snapshots] = await Promise.all([
        getActiveModel(),
        listImportSnapshots().catch(() => [] as ExternalModelSnapshot[]),
      ]);
      setModel(active);
      const ready = snapshots.find((s) => s.status === "ready");
      setSnapshot(ready ?? null);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const handleRefresh = async () => {
    if (!snapshot) return;
    setRefreshing(true);
    try {
      await refreshImport(snapshot.snapshot_id);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRefreshing(false);
    }
  };

  if (loading) {
    return (
      <div className="rounded-xl border border-[var(--border)] bg-[var(--panel-bg)] px-4 py-3 text-sm text-[var(--text-muted)]">
        Loading active model…
      </div>
    );
  }

  if (!model) {
    return (
      <div className="rounded-xl border border-dashed border-[var(--border)] bg-[var(--panel-bg)] px-4 py-3">
        <p className="text-sm font-medium text-[var(--text-primary)]">No active model</p>
        <p className="text-xs text-[var(--text-muted)] mt-0.5">
          Connect a system and import a planning model to power scenarios.
        </p>
        {error && <p className="mt-1 text-xs text-[var(--danger)]">{error}</p>}
      </div>
    );
  }

  const cells = snapshot?.stats?.fact_count;
  const importedAt = snapshot?.stats?.imported_at as string | undefined;

  return (
    <div className="rounded-xl border border-accent/25 bg-accent/5 px-4 py-3 flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--accent-text)]">
          <span aria-hidden="true">★</span> Active model
        </div>
        <p className="mt-0.5 text-sm font-semibold text-[var(--text-primary)] truncate">
          {model.name}
          {cells != null && (
            <span className="ml-2 font-normal text-[var(--text-muted)]">
              · {cells.toLocaleString()} cells
            </span>
          )}
        </p>
        <p className="text-[11px] text-[var(--text-muted)]">
          {importedAt ? `Imported ${relativeTime(importedAt)}` : `Updated ${relativeTime(model.created_at)}`}
        </p>
        {error && <p className="mt-1 text-xs text-[var(--danger)]">{error}</p>}
      </div>
      <div className="flex gap-2">
        {snapshot && (
          <button
            type="button"
            onClick={handleRefresh}
            disabled={refreshing}
            className="rounded-xl border border-[var(--border)] bg-[var(--card-bg)] px-3 py-1.5 text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--panel-bg)] disabled:opacity-40"
          >
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
        )}
        {onShowHistory && (
          <button
            type="button"
            onClick={onShowHistory}
            className="rounded-xl border border-[var(--border)] bg-[var(--card-bg)] px-3 py-1.5 text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--panel-bg)]"
          >
            History
          </button>
        )}
      </div>
    </div>
  );
}
