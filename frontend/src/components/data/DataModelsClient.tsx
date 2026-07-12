"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  deleteConnection,
  getCurrentUser,
  listConnections,
  testPlanningConnection,
  type PlanningConnection,
} from "@/lib/api";
import { probePlanningConnectors, usePlanningConnectorsEnabled } from "@/lib/features";
import { WorkspaceSwitcher } from "../WorkspaceSwitcher";
import { RoleSwitcher } from "../RoleSwitcher";
import { ThemeToggle } from "../ThemeToggle";
import { ActiveModelBanner } from "./ActiveModelBanner";
import { ConnectionCard } from "./ConnectionCard";
import { ConnectionDrawer } from "./ConnectionDrawer";
import { ConfirmDialog } from "./ConfirmDialog";
import { ModelBrowser } from "./ModelBrowser";
import { ImportWizard } from "./ImportWizard";

export default function DataModelsClient() {
  const enabled = usePlanningConnectorsEnabled();
  const [probed, setProbed] = useState(false);
  const [connections, setConnections] = useState<PlanningConnection[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState<PlanningConnection | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<PlanningConnection | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [importTarget, setImportTarget] = useState<{ modelId: string; modelName: string } | null>(null);

  useEffect(() => {
    void probePlanningConnectors().finally(() => setProbed(true));
  }, []);

  const load = useCallback(async () => {
    try {
      const [connRes, user] = await Promise.all([
        listConnections(),
        getCurrentUser().catch(() => null),
      ]);
      setConnections(connRes.connections);
      setIsAdmin(user?.role === "admin");
      setError(null);
      setSelectedId((prev) => {
        if (prev && connRes.connections.some((c) => c.connection_id === prev)) return prev;
        return connRes.connections[0]?.connection_id ?? null;
      });
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void load();
  }, [enabled, load, refreshKey]);

  const selected = connections.find((c) => c.connection_id === selectedId) ?? null;

  const handleTest = async (id: string) => {
    setTestingId(id);
    try {
      const result = await testPlanningConnection(id);
      if (result.ok) toast.success(result.message || "Connected");
      else toast.error(result.message || "Test failed");
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setTestingId(null);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteConnection(deleteTarget.connection_id);
      toast.success("Connection removed");
      setDeleteTarget(null);
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  if (!probed) {
    return (
      <main className="min-h-screen flex items-center justify-center text-sm text-[var(--text-muted)]">
        Loading…
      </main>
    );
  }

  if (!enabled) {
    return (
      <main className="min-h-screen bg-background text-[var(--text-primary)]">
        <header className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
          <Link href="/" className="text-sm text-[var(--accent-text)] hover:underline">
            ← Scenarios
          </Link>
          <h1 className="text-base font-semibold">Data &amp; Models</h1>
          <div className="flex items-center gap-2">
            <RoleSwitcher />
            <ThemeToggle variant="page" />
          </div>
        </header>
        <div className="mx-auto max-w-lg px-4 py-16 text-center">
          <h2 className="text-lg font-semibold">Planning connectors are not enabled</h2>
          <p className="mt-2 text-sm text-[var(--text-muted)]">
            Ask an admin to set <code className="text-xs">ENABLE_PLANNING_CONNECTORS=true</code> and{" "}
            <code className="text-xs">CREDENTIALS_ENCRYPTION_KEY</code> on the backend.
          </p>
          <Link href="/" className="mt-6 inline-block text-sm font-medium text-[var(--accent-text)]">
            Back to scenarios
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen flex-col bg-background text-[var(--text-primary)]">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border)] px-4 py-3">
        <div className="flex items-center gap-3">
          <Link href="/" className="text-sm text-[var(--accent-text)] hover:underline">
            ← Scenarios
          </Link>
          <h1 className="text-base font-semibold tracking-tight">Data &amp; Models</h1>
        </div>
        <div className="flex items-center gap-2">
          <div className="hidden sm:block">
            <WorkspaceSwitcher variant="page" />
          </div>
          <RoleSwitcher />
          <ThemeToggle variant="page" />
        </div>
      </header>

      <div className="px-4 py-3">
        <ActiveModelBanner refreshKey={refreshKey} />
      </div>

      {error && <p className="px-4 text-xs text-[var(--danger)]">{error}</p>}

      <div className="flex min-h-0 flex-1 flex-col border-t border-[var(--border)] md:flex-row">
        <aside className="w-full shrink-0 border-b border-[var(--border)] md:w-80 md:border-b-0 md:border-r">
          <div className="flex items-center justify-between px-4 py-3">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
              Connected systems
            </h2>
            {isAdmin && (
              <button
                type="button"
                onClick={() => {
                  setEditing(null);
                  setDrawerOpen(true);
                }}
                className="rounded-lg bg-accent px-2.5 py-1 text-[11px] font-medium text-[var(--on-accent)] hover:bg-accent-hover"
              >
                + Connect
              </button>
            )}
          </div>
          <div className="space-y-2 px-3 pb-4">
            {connections.length === 0 && (
              <div className="rounded-xl border border-dashed border-[var(--border)] px-3 py-6 text-center">
                <p className="text-sm text-[var(--text-primary)]">No systems connected</p>
                <p className="mt-1 text-xs text-[var(--text-muted)]">
                  {isAdmin
                    ? "Connect SAP Analytics Cloud or use Mock for a demo."
                    : "Ask an admin to add a connection."}
                </p>
              </div>
            )}
            {connections.map((c) => (
              <ConnectionCard
                key={c.connection_id}
                connection={c}
                selected={c.connection_id === selectedId}
                isAdmin={isAdmin}
                testing={testingId === c.connection_id}
                onSelect={() => setSelectedId(c.connection_id)}
                onTest={() => handleTest(c.connection_id)}
                onEdit={() => {
                  setEditing(c);
                  setDrawerOpen(true);
                }}
                onRemove={() => setDeleteTarget(c)}
              />
            ))}
          </div>
        </aside>

        <section className="min-h-[28rem] flex-1">
          <ModelBrowser
            connectionId={selectedId}
            connectionName={selected?.name}
            refreshKey={refreshKey}
            onImport={(modelId, modelName) => setImportTarget({ modelId, modelName })}
          />
        </section>
      </div>

      <ConnectionDrawer
        open={drawerOpen}
        connection={editing}
        onClose={() => setDrawerOpen(false)}
        onSaved={(id) => {
          setDrawerOpen(false);
          setRefreshKey((k) => k + 1);
          if (id) setSelectedId(id);
        }}
        onBrowse={() => setDrawerOpen(false)}
      />

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="Remove connection?"
        description={
          deleteTarget
            ? `Remove “${deleteTarget.name}”? Connections with import history are disabled instead of deleted.`
            : ""
        }
        confirmLabel="Remove"
        danger
        onCancel={() => setDeleteTarget(null)}
        onConfirm={confirmDelete}
      />

      {importTarget && selectedId && (
        <ImportWizard
          open
          connectionId={selectedId}
          modelId={importTarget.modelId}
          modelName={importTarget.modelName}
          onClose={() => setImportTarget(null)}
          onComplete={() => setRefreshKey((k) => k + 1)}
        />
      )}
    </main>
  );
}
