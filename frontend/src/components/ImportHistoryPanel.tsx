"use client";

import { useCallback, useEffect, useState } from "react";
import {
  listConnectionEvents,
  listImportSnapshots,
  refreshImport,
  type ConnectionEvent,
  type ExternalModelSnapshot,
  type ImportStats,
} from "@/lib/api";

export function ImportStatsCard({ stats }: { stats?: ImportStats | null }) {
  if (!stats) return null;
  const counts = [
    ["Facts", stats.fact_count],
    ["Dimensions", stats.dimension_count],
    ["Measures", stats.measure_count],
    ["Errors", stats.error_count ?? stats.errors?.length],
    ["Warnings", stats.warning_count ?? stats.warnings?.length],
  ].filter((entry): entry is [string, number] => typeof entry[1] === "number");
  return (
    <div className="mt-2 rounded-md bg-[var(--panel-bg)] p-2">
      <div className="grid grid-cols-3 gap-1">
        {counts.map(([label, value]) => (
          <div key={label} className="text-center">
            <div className="text-sm font-semibold tabular-nums">{value.toLocaleString()}</div>
            <div className="text-[10px] text-[var(--text-muted)]">{label}</div>
          </div>
        ))}
      </div>
      {stats.errors?.map((message) => <p key={message} className="mt-1 text-[11px] text-[var(--danger)]">{message}</p>)}
      {stats.warnings?.map((message) => <p key={message} className="mt-1 text-[11px] text-[var(--warning)]">{message}</p>)}
    </div>
  );
}

export function ImportHistoryPanel({ connectionId }: { connectionId?: string }) {
  const [snapshots, setSnapshots] = useState<ExternalModelSnapshot[]>([]);
  const [events, setEvents] = useState<ConnectionEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [allSnapshots, connectionEvents] = await Promise.all([
        listImportSnapshots(),
        connectionId ? listConnectionEvents(connectionId) : Promise.resolve([]),
      ]);
      setSnapshots(connectionId
        ? allSnapshots.filter((snapshot) => snapshot.connection_id === connectionId)
        : allSnapshots);
      setEvents(connectionEvents);
      setError(null);
    } catch (loadError) {
      setError((loadError as Error).message);
    }
  }, [connectionId]);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = async (snapshotId: string) => {
    setRefreshing(snapshotId);
    try {
      await refreshImport(snapshotId);
      await load();
    } catch (refreshError) {
      setError((refreshError as Error).message);
    } finally {
      setRefreshing(null);
    }
  };

  return (
    <section className="space-y-2" aria-label="Import history">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">Import history</h3>
      {error && <p className="text-xs text-[var(--danger)]">{error}</p>}
      {snapshots.map((snapshot) => (
        <article key={snapshot.snapshot_id} className="rounded-lg border border-[var(--border)] bg-[var(--card-bg)] p-2.5">
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="text-xs font-medium">{snapshot.external_model_name}</p>
              <p className="text-[10px] text-[var(--text-muted)]">
                {snapshot.status} · {new Date(snapshot.created_at).toLocaleString()}
              </p>
            </div>
            <button
              type="button"
              onClick={() => refresh(snapshot.snapshot_id)}
              disabled={refreshing === snapshot.snapshot_id || snapshot.status === "importing"}
              className="text-[11px] text-accent disabled:opacity-40"
            >
              {refreshing === snapshot.snapshot_id ? "Refreshing…" : "Refresh"}
            </button>
          </div>
          {snapshot.error && <p className="mt-1 text-[11px] text-[var(--danger)]">{snapshot.error}</p>}
          <ImportStatsCard stats={snapshot.stats} />
        </article>
      ))}
      {!snapshots.length && !error && <p className="text-xs text-[var(--text-muted)]">No imports yet.</p>}
      {events.length > 0 && (
        <details>
          <summary className="cursor-pointer text-xs text-[var(--text-muted)]">Connection events ({events.length})</summary>
          <ul className="mt-1 space-y-1">
            {events.map((event, index) => (
              <li key={event.event_id ?? `${event.event_type}-${index}`} className="text-[11px] text-[var(--text-muted)]">
                {event.event_type} · {new Date(event.created_at ?? event.timestamp ?? Date.now()).toLocaleString()}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
