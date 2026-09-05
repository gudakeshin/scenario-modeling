import { create } from "zustand";
import { toast } from "sonner";
import type { Conversation, Message } from "@/types/chat";
import { useSessionStore } from "./sessionStore";
import {
  listStoredConversations,
  getStoredConversation,
  createStoredConversation,
  updateStoredConversation,
  appendStoredMessage,
  deleteStoredConversation,
  deleteStoredConversations,
  type StoredConversationWithMessages,
  type StoredMessageMetadata,
} from "@/lib/api";

/** Unified assistant mode: scenario modeling (approval-gated) vs document Q&A. */
export type AssistantMode = "scenario" | "documents";

// ── Backend write-through bookkeeping (not reactive UI state) ──
// Conversation ids created locally are real UUIDs (see useScenarioWorkflow's
// generateId), so a conversation row can be created on the backend with the
// same id up front — no id remapping needed after the fact.
const remoteConversationIds = new Set<string>();
const pendingCreates = new Map<string, Promise<void>>();
const renameTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pendingMetaPatches = new Map<string, { title?: string; scenario_id?: string | null; session_id?: string | null }>();

function messageMetadata(m: Message): StoredMessageMetadata | undefined {
  const meta: StoredMessageMetadata = {};
  if (m.thinking) meta.thinking = m.thinking;
  if (m.agentTrace?.length) meta.agentTrace = m.agentTrace;
  if (m.causalChain?.length) meta.causalChain = m.causalChain;
  if (m.agentConfidence != null) meta.agentConfidence = m.agentConfidence;
  if (m.agentCitations?.length) meta.agentCitations = m.agentCitations;
  if (m.previewPl) meta.previewPl = m.previewPl;
  if (m.previewReconciliation) meta.previewReconciliation = m.previewReconciliation;
  if (m.constraintViolations?.length) meta.constraintViolations = m.constraintViolations;
  return Object.keys(meta).length > 0 ? meta : undefined;
}

function fromStored(stored: StoredConversationWithMessages): Conversation {
  return {
    id: stored.id,
    title: stored.title,
    updatedAt: new Date(stored.updated_at),
    scenarioId: stored.scenario_id ?? undefined,
    sessionId: stored.session_id ?? undefined,
    messages: stored.messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      timestamp: new Date(m.created_at),
      ...(m.metadata ?? {}),
    })),
  };
}

/** Ensure the conversation exists on the backend before writing messages to it. Idempotent. */
async function ensureRemoteConversation(conv: Conversation): Promise<void> {
  if (remoteConversationIds.has(conv.id)) return;
  const existing = pendingCreates.get(conv.id);
  if (existing) return existing;

  const p = (async () => {
    try {
      await createStoredConversation({
        id: conv.id,
        title: conv.title,
        scenario_id: conv.scenarioId ?? undefined,
        session_id: conv.sessionId ?? undefined,
      });
      remoteConversationIds.add(conv.id);
    } catch (e) {
      toast.error("Couldn't save this conversation", {
        description: (e as Error).message || "It will only persist for this session.",
      });
      throw e;
    } finally {
      pendingCreates.delete(conv.id);
    }
  })();
  pendingCreates.set(conv.id, p);
  return p;
}

/** Optimistic-UI write-through: the caller already applied the local update; this persists async. */
async function persistMessage(conv: Conversation | undefined, message: Message): Promise<void> {
  if (!conv) return;
  try {
    await ensureRemoteConversation(conv);
    await appendStoredMessage(conv.id, {
      id: message.id,
      role: message.role,
      content: message.content,
      timestamp: message.timestamp.toISOString(),
      metadata: messageMetadata(message),
    });
  } catch (e) {
    if (remoteConversationIds.has(conv.id)) {
      toast.error("Message wasn't saved", {
        description: (e as Error).message || "Reloading may lose this message.",
      });
    }
    // ensureRemoteConversation already surfaced a toast on create failure.
  }
}

interface ConversationMetaPatch {
  title?: string;
  scenario_id?: string | null;
  session_id?: string | null;
}

/**
 * Debounced so rapid edits (e.g. programmatic title/session updates) collapse
 * into one write. Ensures the conversation row exists first — this can race
 * ahead of the create triggered by the first message, so it's idempotent.
 */
function persistMeta(conv: Conversation, patch: ConversationMetaPatch): void {
  const existingTimer = renameTimers.get(conv.id);
  if (existingTimer) clearTimeout(existingTimer);
  const pending = { ...(pendingMetaPatches.get(conv.id) ?? {}), ...patch };
  pendingMetaPatches.set(conv.id, pending);
  renameTimers.set(
    conv.id,
    setTimeout(() => {
      renameTimers.delete(conv.id);
      const toSend = pendingMetaPatches.get(conv.id);
      pendingMetaPatches.delete(conv.id);
      if (!toSend) return;
      void (async () => {
        try {
          await ensureRemoteConversation(conv);
          await updateStoredConversation(conv.id, toSend);
        } catch (e) {
          if (remoteConversationIds.has(conv.id)) {
            toast.error("Conversation update didn't save", { description: (e as Error).message });
          }
        }
      })();
    }, 400),
  );
}

function persistDelete(ids: string[]): void {
  const remoteIds = ids.filter((id) => remoteConversationIds.has(id));
  for (const id of ids) remoteConversationIds.delete(id);
  if (remoteIds.length === 0) return;
  const run =
    remoteIds.length === 1
      ? deleteStoredConversation(remoteIds[0])
      : deleteStoredConversations(remoteIds).then(() => undefined);
  run.catch((e) => {
    toast.error("Delete didn't sync", { description: (e as Error).message });
  });
}

interface ChatState {
  conversations: Conversation[];
  activeId: string | null;
  /** Chat surface mode — Document Q&A does not bypass scenario approval. */
  assistantMode: AssistantMode;
  /** RAG conversation id when in documents mode (auth'd API). */
  documentConversationId: string | null;
  /** True once hydrateFromBackend has resolved (successfully or not) for the current workspace. */
  hydrated: boolean;
  setAssistantMode: (mode: AssistantMode) => void;
  setDocumentConversationId: (id: string | null) => void;
  setConversations: (
    next: Conversation[] | ((prev: Conversation[]) => Conversation[])
  ) => void;
  setActiveId: (id: string | null) => void;
  addMessage: (convId: string, message: Message) => void;
  updateConversation: (
    convId: string,
    patch: Partial<Conversation> | ((c: Conversation) => Conversation)
  ) => void;
  selectConversation: (id: string) => void;
  renameConversation: (id: string, title: string) => void;
  deleteConversation: (id: string) => void;
  deleteConversations: (ids: string[]) => void;
  /** Load this workspace's conversation history from the backend. Call on mount and workspace switch. */
  hydrateFromBackend: () => Promise<void>;
}

export const useChatStore = create<ChatState>((set, get) => ({
  conversations: [],
  activeId: null,
  assistantMode: "scenario",
  documentConversationId: null,
  hydrated: false,

  setAssistantMode: (mode) => set({ assistantMode: mode }),
  setDocumentConversationId: (id) => set({ documentConversationId: id }),

  setConversations: (next) =>
    set((state) => ({
      conversations: typeof next === "function" ? next(state.conversations) : next,
    })),

  setActiveId: (id) => set({ activeId: id }),

  addMessage: (convId, message) => {
    set((state) => ({
      conversations: state.conversations.map((c) =>
        c.id !== convId
          ? c
          : { ...c, messages: [...c.messages, message], updatedAt: new Date() }
      ),
    }));
    void persistMessage(get().conversations.find((c) => c.id === convId), message);
  },

  updateConversation: (convId, patch) => {
    const before = get().conversations.find((c) => c.id === convId);
    const beforeCount = before?.messages.length ?? 0;
    set((state) => ({
      conversations: state.conversations.map((c) => {
        if (c.id !== convId) return c;
        return typeof patch === "function" ? patch(c) : { ...c, ...patch };
      }),
    }));
    const after = get().conversations.find((c) => c.id === convId);
    if (after && after.messages.length > beforeCount) {
      // Persist every message appended by this update (normally exactly one).
      for (const m of after.messages.slice(beforeCount)) {
        void persistMessage(after, m);
      }
    }
    if (after && before) {
      const metaPatch: ConversationMetaPatch = {};
      if (after.title !== before.title) metaPatch.title = after.title;
      if (after.scenarioId !== before.scenarioId) metaPatch.scenario_id = after.scenarioId ?? null;
      if (after.sessionId !== before.sessionId) metaPatch.session_id = after.sessionId ?? null;
      if (Object.keys(metaPatch).length > 0) persistMeta(after, metaPatch);
    }
  },

  selectConversation: (id) => {
    const conv = get().conversations.find((c) => c.id === id);
    set({ activeId: id });
    // Restore session for this conversation instead of dropping it
    useSessionStore.getState().setSession(conv?.sessionId ?? null, conv?.scenarioId ?? null);
  },

  renameConversation: (id, title) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    set((state) => ({
      conversations: state.conversations.map((c) =>
        c.id !== id ? c : { ...c, title: trimmed, updatedAt: new Date() }
      ),
    }));
    const conv = get().conversations.find((c) => c.id === id);
    if (conv) persistMeta(conv, { title: trimmed });
  },

  deleteConversation: (id) => {
    const state = get();
    const next = state.conversations.filter((c) => c.id !== id);
    const wasActive = state.activeId === id;
    set({
      conversations: next,
      activeId: wasActive ? (next[0]?.id ?? null) : state.activeId,
    });
    persistDelete([id]);
    if (wasActive) {
      const nextActive = next[0];
      useSessionStore
        .getState()
        .setSession(nextActive?.sessionId ?? null, nextActive?.scenarioId ?? null);
    }
  },

  deleteConversations: (ids) => {
    if (ids.length === 0) return;
    if (ids.length === 1) {
      get().deleteConversation(ids[0]);
      return;
    }
    const remove = new Set(ids);
    const state = get();
    const next = state.conversations.filter((c) => !remove.has(c.id));
    const wasActive = state.activeId != null && remove.has(state.activeId);
    set({
      conversations: next,
      activeId: wasActive ? (next[0]?.id ?? null) : state.activeId,
    });
    persistDelete(ids);
    if (wasActive) {
      const nextActive = next[0];
      useSessionStore
        .getState()
        .setSession(nextActive?.sessionId ?? null, nextActive?.scenarioId ?? null);
    }
  },

  hydrateFromBackend: async () => {
    remoteConversationIds.clear();
    pendingCreates.clear();
    try {
      const summaries = await listStoredConversations();
      const full = await Promise.all(
        summaries.map((s) =>
          getStoredConversation(s.id).catch(() => null),
        ),
      );
      const conversations = full
        .filter((c): c is StoredConversationWithMessages => c != null)
        .map(fromStored)
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
      for (const c of conversations) remoteConversationIds.add(c.id);
      set((state) => ({
        conversations,
        // Preserve current selection if it still exists after hydration; else clear.
        activeId: conversations.some((c) => c.id === state.activeId) ? state.activeId : null,
        hydrated: true,
      }));
    } catch (e) {
      toast.error("Couldn't load saved conversations", {
        description: (e as Error).message || "Starting with an empty chat history.",
      });
      set({ hydrated: true });
    }
  },
}));
