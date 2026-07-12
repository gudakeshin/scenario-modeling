import { create } from "zustand";
import type { Conversation, Message } from "@/types/chat";
import { useSessionStore } from "./sessionStore";

/** Unified assistant mode: scenario modeling (approval-gated) vs document Q&A. */
export type AssistantMode = "scenario" | "documents";

interface ChatState {
  conversations: Conversation[];
  activeId: string | null;
  /** Chat surface mode — Document Q&A does not bypass scenario approval. */
  assistantMode: AssistantMode;
  /** RAG conversation id when in documents mode (auth'd API). */
  documentConversationId: string | null;
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
}

export const useChatStore = create<ChatState>((set, get) => ({
  conversations: [],
  activeId: null,
  assistantMode: "scenario",
  documentConversationId: null,

  setAssistantMode: (mode) => set({ assistantMode: mode }),
  setDocumentConversationId: (id) => set({ documentConversationId: id }),

  setConversations: (next) =>
    set((state) => ({
      conversations: typeof next === "function" ? next(state.conversations) : next,
    })),

  setActiveId: (id) => set({ activeId: id }),

  addMessage: (convId, message) =>
    set((state) => ({
      conversations: state.conversations.map((c) =>
        c.id !== convId
          ? c
          : { ...c, messages: [...c.messages, message], updatedAt: new Date() }
      ),
    })),

  updateConversation: (convId, patch) =>
    set((state) => ({
      conversations: state.conversations.map((c) => {
        if (c.id !== convId) return c;
        return typeof patch === "function" ? patch(c) : { ...c, ...patch };
      }),
    })),

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
  },

  deleteConversation: (id) => {
    const state = get();
    const next = state.conversations.filter((c) => c.id !== id);
    const wasActive = state.activeId === id;
    set({
      conversations: next,
      activeId: wasActive ? (next[0]?.id ?? null) : state.activeId,
    });
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
    if (wasActive) {
      const nextActive = next[0];
      useSessionStore
        .getState()
        .setSession(nextActive?.sessionId ?? null, nextActive?.scenarioId ?? null);
    }
  },
}));
