import { create } from "zustand";
import {
  listWorkspaces,
  createWorkspace as apiCreateWorkspace,
  renameWorkspace as apiRenameWorkspace,
  deleteWorkspace as apiDeleteWorkspace,
  getActiveWorkspaceId,
  setActiveWorkspaceId,
  type Workspace,
} from "@/lib/api";
import { useSessionStore } from "./sessionStore";
import { useChatStore } from "./chatStore";
import { useUiStore } from "./uiStore";

/**
 * Everything user-visible is derived from the active workspace, so switching
 * must clear session, chat, and workspace-derived UI state. Refetching is
 * driven by effects that depend on `activeWorkspaceId`.
 */
function resetWorkspaceState(): void {
  useSessionStore.getState().clearSession();
  const chat = useChatStore.getState();
  chat.setConversations([]);
  chat.setActiveId(null);
  const ui = useUiStore.getState();
  ui.closeAllPanels();
  ui.setOnboardingStatus(null);
  ui.setChartData(null);
  ui.setPeriodData(null);
  ui.setPreloadedInsight(null);
  ui.setPendingQuestions(null);
}

interface WorkspaceState {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  loaded: boolean;
  loadWorkspaces: () => Promise<void>;
  switchWorkspace: (id: string) => void;
  createWorkspace: (name: string) => Promise<Workspace>;
  renameWorkspace: (id: string, name: string) => Promise<void>;
  deleteWorkspace: (id: string) => Promise<void>;
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  workspaces: [],
  // Hydrated from localStorage (same key api.ts reads to set the header).
  activeWorkspaceId: getActiveWorkspaceId(),
  loaded: false,

  loadWorkspaces: async () => {
    const workspaces = await listWorkspaces();
    // Reconcile the persisted id: fall back to the default workspace when
    // it's stale (deleted elsewhere) or was never set.
    const persisted = getActiveWorkspaceId();
    const valid = persisted && workspaces.some((w) => w.workspace_id === persisted);
    const active = valid ? persisted : (workspaces.find((w) => w.is_default) ?? workspaces[0])?.workspace_id ?? null;
    if (active !== persisted) setActiveWorkspaceId(active);
    set({ workspaces, activeWorkspaceId: active, loaded: true });
  },

  switchWorkspace: (id) => {
    if (id === get().activeWorkspaceId) return;
    setActiveWorkspaceId(id);
    resetWorkspaceState();
    set({ activeWorkspaceId: id });
  },

  createWorkspace: async (name) => {
    const ws = await apiCreateWorkspace(name);
    set({ workspaces: [...get().workspaces, ws] });
    return ws;
  },

  renameWorkspace: async (id, name) => {
    const ws = await apiRenameWorkspace(id, name);
    set({ workspaces: get().workspaces.map((w) => (w.workspace_id === id ? { ...w, ...ws } : w)) });
  },

  deleteWorkspace: async (id) => {
    await apiDeleteWorkspace(id);
    const remaining = get().workspaces.filter((w) => w.workspace_id !== id);
    set({ workspaces: remaining });
    if (get().activeWorkspaceId === id) {
      const fallback = (remaining.find((w) => w.is_default) ?? remaining[0])?.workspace_id ?? null;
      setActiveWorkspaceId(fallback);
      resetWorkspaceState();
      set({ activeWorkspaceId: fallback });
    }
  },
}));
