import { create } from "zustand";
import type {
  BusinessInsight,
  PeriodResult,
  FollowUpQuestion,
  OnboardingStatus,
  DimensionalResultBlock,
} from "@/lib/api";
import type { PanelId } from "@/lib/panels";

export type ChartData = {
  scenarioId?: string;
  pl: Record<string, number>;
  basePl?: Record<string, number>;
  periods?: PeriodResult[];
  granularity?: "monthly" | "quarterly";
  dimensional?: DimensionalResultBlock;
};

export type PeriodData = {
  periods: PeriodResult[];
  granularity: "monthly" | "quarterly";
  pl: Record<string, number>;
};

interface UiState {
  /** Panels the user has opened, in the order they were opened (== chip order). */
  openPanels: PanelId[];
  /** The one panel currently expanded into the modal, if any. */
  expandedPanel: PanelId | null;

  /** When opening Document Manager for validation, land on Context. */
  docManagerInitialTab: "documents" | "context" | "model" | null;

  preloadedInsight: BusinessInsight | null;
  periodData: PeriodData | null;
  chartData: ChartData | null;
  pendingQuestions: FollowUpQuestion[] | null;
  onboardingStatus: OnboardingStatus | null;
  refineKey: number;
  isLoading: boolean;

  dimensionalPov: Record<string, string>;
  dimensionalMetric: string | null;

  /** Add to the strip and expand it. */
  openPanel: (id: PanelId) => void;
  /** Add to the strip without changing what is expanded. */
  showPanel: (id: PanelId) => void;
  /** Remove from the strip; collapse the modal if this panel was the expanded one. */
  closePanel: (id: PanelId) => void;
  /** Open+expand when closed, close+collapse when open. */
  togglePanel: (id: PanelId) => void;
  isPanelOpen: (id: PanelId) => boolean;
  setExpandedPanel: (v: PanelId | null) => void;

  setDocManagerInitialTab: (v: "documents" | "context" | "model" | null) => void;
  openDocManagerForValidation: () => void;
  openDocManagerModel: () => void;
  openReviewForRerun: () => void;

  setPreloadedInsight: (v: BusinessInsight | null) => void;
  setPeriodData: (v: PeriodData | null) => void;
  setChartData: (v: ChartData | null) => void;
  setPendingQuestions: (v: FollowUpQuestion[] | null) => void;
  setOnboardingStatus: (v: OnboardingStatus | null) => void;
  bumpRefineKey: () => void;
  setIsLoading: (v: boolean) => void;
  setDimensionalPov: (v: Record<string, string>) => void;
  setDimensionalMetric: (v: string | null) => void;
  closeAllPanels: () => void;
}

const withPanel = (open: PanelId[], id: PanelId): PanelId[] =>
  open.includes(id) ? open : [...open, id];

export const useUiStore = create<UiState>((set, get) => ({
  openPanels: [],
  expandedPanel: null,
  docManagerInitialTab: null,

  preloadedInsight: null,
  periodData: null,
  chartData: null,
  pendingQuestions: null,
  onboardingStatus: null,
  refineKey: 0,
  isLoading: false,
  dimensionalPov: {},
  dimensionalMetric: null,

  openPanel: (id) =>
    set((s) => ({ openPanels: withPanel(s.openPanels, id), expandedPanel: id })),

  showPanel: (id) => set((s) => ({ openPanels: withPanel(s.openPanels, id) })),

  closePanel: (id) =>
    set((s) => ({
      openPanels: s.openPanels.filter((p) => p !== id),
      expandedPanel: s.expandedPanel === id ? null : s.expandedPanel,
      // The follow-up panel is driven by pendingQuestions, so closing it must
      // clear them or it would immediately re-open.
      ...(id === "followUp" ? { pendingQuestions: null } : null),
    })),

  togglePanel: (id) =>
    set((s) =>
      s.openPanels.includes(id)
        ? {
            openPanels: s.openPanels.filter((p) => p !== id),
            expandedPanel: s.expandedPanel === id ? null : s.expandedPanel,
            ...(id === "followUp" ? { pendingQuestions: null } : null),
          }
        : { openPanels: withPanel(s.openPanels, id), expandedPanel: id },
    ),

  isPanelOpen: (id) => get().openPanels.includes(id),

  setExpandedPanel: (v) =>
    set((s) => ({
      expandedPanel: v,
      // Expanding a panel implies it is open.
      openPanels: v ? withPanel(s.openPanels, v) : s.openPanels,
    })),

  setDocManagerInitialTab: (v) => set({ docManagerInitialTab: v }),

  openDocManagerForValidation: () =>
    set((s) => ({
      openPanels: withPanel(s.openPanels, "docManager"),
      docManagerInitialTab: "context",
      expandedPanel: "docManager",
    })),

  openDocManagerModel: () =>
    set((s) => ({
      openPanels: withPanel(s.openPanels, "docManager"),
      docManagerInitialTab: "model",
      expandedPanel: "docManager",
    })),

  openReviewForRerun: () =>
    set((s) => ({
      openPanels: withPanel(s.openPanels, "review"),
      expandedPanel: "review",
    })),

  setPreloadedInsight: (v) => set({ preloadedInsight: v }),
  setPeriodData: (v) => set({ periodData: v }),
  setChartData: (v) => set({ chartData: v }),
  setPendingQuestions: (v) =>
    set((s) => ({
      pendingQuestions: v,
      openPanels:
        v && v.length > 0
          ? withPanel(s.openPanels, "followUp")
          : s.openPanels.filter((p) => p !== "followUp"),
      expandedPanel:
        (!v || v.length === 0) && s.expandedPanel === "followUp" ? null : s.expandedPanel,
    })),
  setOnboardingStatus: (v) => set({ onboardingStatus: v }),
  bumpRefineKey: () => set((s) => ({ refineKey: s.refineKey + 1 })),
  setIsLoading: (v) => set({ isLoading: v }),
  setDimensionalPov: (v) => set({ dimensionalPov: v }),
  setDimensionalMetric: (v) => set({ dimensionalMetric: v }),

  closeAllPanels: () =>
    set({
      openPanels: [],
      expandedPanel: null,
      docManagerInitialTab: null,
      preloadedInsight: null,
      periodData: null,
      pendingQuestions: null,
      dimensionalPov: {},
      dimensionalMetric: null,
    }),
}));
