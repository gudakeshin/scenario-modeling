"use client";

import { useEffect, useRef, useState } from "react";
import { useWorkspaceStore } from "@/stores/workspaceStore";

type ChromeVariant = "sidebar" | "page";

const chrome = {
  sidebar: {
    root: "relative px-3 pt-3",
    trigger:
      "w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg border border-[var(--sidebar-border)] hover:bg-[var(--sidebar-hover)] text-[var(--sidebar-text)] transition-colors",
    menu: "absolute left-3 right-3 z-30 mt-1 rounded-lg border border-[var(--sidebar-border)] bg-[var(--sidebar-bg)] shadow-lg overflow-hidden",
    option:
      "flex-1 min-w-0 flex items-center gap-2 px-3 py-2 text-left text-sm text-[var(--sidebar-text)] hover:bg-[var(--sidebar-hover)] transition-colors",
    muted: "text-[var(--sidebar-text-muted)]",
    mutedHover: "p-1 rounded text-[var(--sidebar-text-muted)] hover:text-[var(--sidebar-text)]",
    deleteHover: "p-1 rounded text-[var(--sidebar-text-muted)] hover:text-[var(--danger)]",
    divider: "border-t border-[var(--sidebar-border)] p-2",
    input:
      "flex-1 min-w-0 px-2 py-1.5 text-sm rounded border border-[var(--sidebar-border)] bg-transparent text-[var(--sidebar-text)] outline-none focus:border-[var(--sidebar-text-muted)]",
    addBtn:
      "px-2 py-1.5 text-sm rounded text-[var(--sidebar-text)] hover:bg-[var(--sidebar-hover)] disabled:opacity-50",
    newBtn:
      "w-full flex items-center gap-2 px-2 py-1.5 text-sm rounded text-[var(--sidebar-text-muted)] hover:text-[var(--sidebar-text)] hover:bg-[var(--sidebar-hover)] transition-colors",
  },
  page: {
    root: "relative",
    trigger:
      "w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg border border-[var(--border)] hover:bg-[var(--panel-bg)] text-[var(--text-primary)] transition-colors",
    menu: "absolute left-0 right-0 z-30 mt-1 min-w-[14rem] rounded-lg border border-[var(--border)] bg-[var(--card-bg)] shadow-lg overflow-hidden",
    option:
      "flex-1 min-w-0 flex items-center gap-2 px-3 py-2 text-left text-sm text-[var(--text-primary)] hover:bg-[var(--panel-bg)] transition-colors",
    muted: "text-[var(--text-muted)]",
    mutedHover: "p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)]",
    deleteHover: "p-1 rounded text-[var(--text-muted)] hover:text-[var(--danger)]",
    divider: "border-t border-[var(--border)] p-2",
    input:
      "flex-1 min-w-0 px-2 py-1.5 text-sm rounded border border-[var(--border)] bg-[var(--card-bg)] text-[var(--text-primary)] placeholder:text-[var(--text-faint)] outline-none focus:border-accent/40",
    addBtn:
      "px-2 py-1.5 text-sm rounded text-[var(--text-primary)] hover:bg-[var(--panel-bg)] disabled:opacity-50",
    newBtn:
      "w-full flex items-center gap-2 px-2 py-1.5 text-sm rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--panel-bg)] transition-colors",
  },
} as const;

/**
 * Workspace selector — each workspace has its own documents, model, and
 * scenarios. Switching swaps the entire app context.
 *
 * `variant="sidebar"` (default) uses dark sidebar tokens.
 * `variant="page"` uses page surface tokens for light headers (e.g. Data & Models).
 */
export function WorkspaceSwitcher({ variant = "sidebar" }: { variant?: ChromeVariant }) {
  const { workspaces, activeWorkspaceId, loaded, loadWorkspaces, switchWorkspace, createWorkspace, renameWorkspace, deleteWorkspace } =
    useWorkspaceStore();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const c = chrome[variant];

  useEffect(() => {
    if (!loaded) loadWorkspaces().catch(() => {});
  }, [loaded, loadWorkspaces]);

  useEffect(() => {
    if (creating) inputRef.current?.focus();
  }, [creating]);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
        setCreating(false);
        setError(null);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  const active = workspaces.find((w) => w.workspace_id === activeWorkspaceId);

  const handleCreate = async () => {
    const name = draft.trim();
    if (!name || busy) return;
    setBusy(true);
    setError(null);
    try {
      const ws = await createWorkspace(name);
      setDraft("");
      setCreating(false);
      switchWorkspace(ws.workspace_id);
      setOpen(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleRename = async (id: string, currentName: string) => {
    const name = window.prompt("Rename workspace", currentName)?.trim();
    if (!name || name === currentName) return;
    try {
      await renameWorkspace(id, name);
    } catch (e) {
      window.alert((e as Error).message);
    }
  };

  const handleDelete = async (id: string, name: string, docCount?: number, scenarioCount?: number) => {
    const detail = `This permanently deletes ${docCount ?? 0} document(s) and archives ${scenarioCount ?? 0} scenario(s).`;
    if (!window.confirm(`Delete workspace "${name}"?\n\n${detail}`)) return;
    try {
      await deleteWorkspace(id);
    } catch (e) {
      window.alert((e as Error).message);
    }
  };

  return (
    <div ref={rootRef} className={c.root}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={c.trigger}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="flex items-center gap-2 min-w-0">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="flex-shrink-0 opacity-70">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          </svg>
          <span className="truncate text-sm font-medium">{active?.name ?? "Workspace"}</span>
        </span>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="flex-shrink-0 opacity-60">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div className={c.menu}>
          <ul role="listbox" className="max-h-64 overflow-y-auto py-1">
            {workspaces.map((w) => (
              <li key={w.workspace_id} className="group flex items-center">
                <button
                  type="button"
                  role="option"
                  aria-selected={w.workspace_id === activeWorkspaceId}
                  onClick={() => {
                    switchWorkspace(w.workspace_id);
                    setOpen(false);
                  }}
                  className={c.option}
                >
                  <span className="w-4 flex-shrink-0">
                    {w.workspace_id === activeWorkspaceId && (
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <path d="M20 6L9 17l-5-5" />
                      </svg>
                    )}
                  </span>
                  <span className="truncate">{w.name}</span>
                  {w.is_default && (
                    <span className={`text-[10px] uppercase tracking-wide flex-shrink-0 ${c.muted}`}>
                      default
                    </span>
                  )}
                </button>
                <span className="hidden group-hover:flex items-center pr-2 gap-1">
                  <button
                    type="button"
                    onClick={() => handleRename(w.workspace_id, w.name)}
                    className={c.mutedHover}
                    aria-label={`Rename ${w.name}`}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" />
                    </svg>
                  </button>
                  {workspaces.length > 1 && (
                    <button
                      type="button"
                      onClick={() => handleDelete(w.workspace_id, w.name, w.document_count, w.scenario_count)}
                      className={c.deleteHover}
                      aria-label={`Delete ${w.name}`}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                      </svg>
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>

          <div className={c.divider}>
            {creating ? (
              <div className="flex items-center gap-1">
                <input
                  ref={inputRef}
                  type="text"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      handleCreate();
                    } else if (e.key === "Escape") {
                      setCreating(false);
                      setError(null);
                    }
                  }}
                  placeholder="Workspace name"
                  className={c.input}
                />
                <button
                  type="button"
                  onClick={handleCreate}
                  disabled={busy || !draft.trim()}
                  className={c.addBtn}
                >
                  Add
                </button>
              </div>
            ) : (
              <button type="button" onClick={() => setCreating(true)} className={c.newBtn}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
                New workspace
              </button>
            )}
            {error && <p className="mt-1 px-2 text-xs text-[var(--danger)]">{error}</p>}
          </div>
        </div>
      )}
    </div>
  );
}
