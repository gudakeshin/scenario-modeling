import { create } from "zustand";

interface SessionState {
  sessionId: string | null;
  scenarioId: string | null;
  setSessionId: (id: string | null) => void;
  setScenarioId: (id: string | null) => void;
  setSession: (sessionId: string | null, scenarioId: string | null) => void;
  clearSession: () => void;
}

export const useSessionStore = create<SessionState>((set) => ({
  sessionId: null,
  scenarioId: null,

  setSessionId: (id) => set({ sessionId: id }),
  setScenarioId: (id) => set({ scenarioId: id }),
  setSession: (sessionId, scenarioId) => set({ sessionId, scenarioId }),
  clearSession: () => set({ sessionId: null, scenarioId: null }),
}));
