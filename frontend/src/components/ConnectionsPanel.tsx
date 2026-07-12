"use client";

import { useState, useEffect, useCallback } from "react";
import { PanelHeader } from "./PanelHeader";
import {
  listConnections,
  deleteConnection,
  testPlanningConnection,
  getCurrentUser,
  type PlanningConnection,
} from "@/lib/api";
import { ConnectionForm } from "./ConnectionForm";
import { ImportHistoryPanel } from "./ImportHistoryPanel";

interface Props {
  onClose: () => void;
  onMinimize?: () => void;
  onOpenImport?: (connectionId: string) => void;
}

export function ConnectionsPanel({ onClose, onMinimize, onOpenImport }: Props) {
  const [connections, setConnections] = useState<PlanningConnection[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<PlanningConnection | "new" | null>(null);
  const [historyConnectionId, setHistoryConnectionId] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { connections: rows } = await listConnections();
      setConnections(rows);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    getCurrentUser()
      .then((user) => setIsAdmin(user.role === "admin"))
      .catch(() => setIsAdmin(false));
  }, [load]);

  const handleTest = async (id: string) => {
    setTesting(id);
    setError(null);
    try {
      const r = await testPlanningConnection(id);
      if (!r.ok) setError(r.message || "Test failed");
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setTesting(null);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Remove this connection?")) return;
    try {
      await deleteConnection(id);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      <PanelHeader
        title="Planning Connections"
        icon={
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 2L2 7l10 5 10-5-10-5z" />
            <path d="M2 17l10 5 10-5" />
            <path d="M2 12l10 5 10-5" />
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

      <div className="flex-1 overflow-y-auto px-3 pb-3 space-y-2">
        <div className="flex justify-between items-center">
          <p className="text-xs text-[var(--text-muted)]">
            Connect SAP Analytics Cloud (or mock) to import planning models.
          </p>
          {isAdmin && (
            <button
              type="button"
              onClick={() => setEditing(editing === "new" ? null : "new")}
              className="text-xs font-medium text-accent hover:underline"
            >
              {editing === "new" ? "Cancel" : "Add"}
            </button>
          )}
        </div>

        {editing && (
          <ConnectionForm
            connection={editing === "new" ? null : editing}
            onCancel={() => setEditing(null)}
            onSaved={async () => {
              setEditing(null);
              await load();
            }}
          />
        )}

        {loading && <p className="text-xs text-[var(--text-muted)]">Loading…</p>}

        {connections.map((c) => (
          <div
            key={c.connection_id}
            className="border border-[var(--border)] rounded-lg p-3 bg-[var(--card-bg)]"
          >
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="text-sm font-medium text-[var(--text-primary)]">{c.name}</div>
                <div className="text-[11px] text-[var(--text-muted)]">
                  {c.provider} · {c.base_url}
                </div>
                {c.last_test_at && (
                  <div className="text-[11px] mt-0.5">
                    Last test:{" "}
                    <span className={c.last_test_ok ? "text-[var(--success)]" : "text-[var(--danger)]"}>
                      {c.last_test_ok ? "OK" : "Failed"}
                    </span>
                  </div>
                )}
              </div>
              <div className="flex flex-col gap-1">
                <button
                  type="button"
                  onClick={() => handleTest(c.connection_id)}
                  disabled={testing === c.connection_id}
                  className="text-[11px] text-accent hover:underline"
                >
                  {testing === c.connection_id ? "Testing…" : "Test"}
                </button>
                {onOpenImport && (
                  <button
                    type="button"
                    onClick={() => onOpenImport(c.connection_id)}
                    className="text-[11px] text-accent hover:underline"
                  >
                    Import
                  </button>
                )}
                <button type="button" onClick={() => setHistoryConnectionId(
                  historyConnectionId === c.connection_id ? null : c.connection_id,
                )} className="text-[11px] text-accent hover:underline">
                  History
                </button>
                {isAdmin && (
                  <>
                    <button type="button" onClick={() => setEditing(c)} className="text-[11px] text-accent hover:underline">
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDelete(c.connection_id)}
                      className="text-[11px] text-[var(--danger)] hover:underline"
                    >
                      Remove
                    </button>
                  </>
                )}
              </div>
            </div>
            {historyConnectionId === c.connection_id && (
              <div className="mt-3 border-t border-[var(--border)] pt-3">
                <ImportHistoryPanel connectionId={c.connection_id} />
              </div>
            )}
          </div>
        ))}

        {!loading && connections.length === 0 && !editing && (
          <p className="text-xs text-[var(--text-muted)]">
            {isAdmin ? "No connections yet. Add one to import a planning model." : "No planning connections are available."}
          </p>
        )}
      </div>
    </div>
  );
}
