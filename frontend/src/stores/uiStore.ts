import { create } from "zustand";
import type {
  BusinessInsight,
  PeriodResult,
  FollowUpQuestion,
  OnboardingStatus,
  DimensionalResultBlock,
} from "@/lib/api";

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
  showReview: boolean;
  showComparison: boolean;
  showAudit: boolean;
  showMonteCarlo: boolean;
  showTornado: boolean;
  showTemplates: boolean;
  showInsights: boolean;
  showPeriods: boolean;
  showCharts: boolean;
  showSharing: boolean;
  showRoles: boolean;
  showDocuments: boolean;
  showDocManager: boolean;

  preloadedInsight: BusinessInsight | null;
  periodData: PeriodData | null;
  chartData: ChartData | null;
  pendingQuestions: FollowUpQuestion[] | null;
  onboardingStatus: OnboardingStatus | null;
  refineKey: number;
  isLoading: boolean;
  expandedPanel: string | null;

  dimensionalPov: Record<string, string>;
  dimensionalMetric: string | null;

  setShowReview: (v: boolean) => void;
  setShowComparison: (v: boolean) => void;
  setShowAudit: (v: boolean) => void;
  setShowMonteCarlo: (v: boolean) => void;
  setShowTornado: (v: boolean) => void;
  setShowTemplates: (v: boolean) => void;
  setShowInsights: (v: boolean) => void;
  setShowPeriods: (v: boolean) => void;
  setShowCharts: (v: boolean) => void;
  setShowSharing: (v: boolean) => void;
  setShowRoles: (v: boolean) => void;
  setShowDocuments: (v: boolean) => void;
  setShowDocManager: (v: boolean) => void;

  toggleShowReview: () => void;
  toggleShowComparison: () => void;
  toggleShowAudit: () => void;
  toggleShowMonteCarlo: () => void;
  toggleShowTornado: () => void;
  toggleShowTemplates: () => void;
  toggleShowInsights: () => void;
  toggleShowPeriods: () => void;
  toggleShowCharts: () => void;
  toggleShowSharing: () => void;
  toggleShowRoles: () => void;
  toggleShowDocuments: () => void;
  toggleShowDocManager: () => void;

  setPreloadedInsight: (v: BusinessInsight | null) => void;
  setPeriodData: (v: PeriodData | null) => void;
  setChartData: (v: ChartData | null) => void;
  setPendingQuestions: (v: FollowUpQuestion[] | null) => void;
  setOnboardingStatus: (v: OnboardingStatus | null) => void;
  bumpRefineKey: () => void;
  setIsLoading: (v: boolean) => void;
  setExpandedPanel: (v: string | null) => void;
  setDimensionalPov: (v: Record<string, string>) => void;
  setDimensionalMetric: (v: string | null) => void;
  closeAllPanels: () => void;
}

export const useUiStore = create<UiState>((set) => ({
  showReview: false,
  showComparison: false,
  showAudit: false,
  showMonteCarlo: false,
  showTornado: false,
  showTemplates: false,
  showInsights: false,
  showPeriods: false,
  showCharts: false,
  showSharing: false,
  showRoles: false,
  showDocuments: false,
  showDocManager: false,

  preloadedInsight: null,
  periodData: null,
  chartData: null,
  pendingQuestions: null,
  onboardingStatus: null,
  refineKey: 0,
  isLoading: false,
  expandedPanel: null,
  dimensionalPov: {},
  dimensionalMetric: null,

  setShowReview: (v) => set({ showReview: v }),
  setShowComparison: (v) => set({ showComparison: v }),
  setShowAudit: (v) => set({ showAudit: v }),
  setShowMonteCarlo: (v) => set({ showMonteCarlo: v }),
  setShowTornado: (v) => set({ showTornado: v }),
  setShowTemplates: (v) => set({ showTemplates: v }),
  setShowInsights: (v) => set({ showInsights: v }),
  setShowPeriods: (v) => set({ showPeriods: v }),
  setShowCharts: (v) => set({ showCharts: v }),
  setShowSharing: (v) => set({ showSharing: v }),
  setShowRoles: (v) => set({ showRoles: v }),
  setShowDocuments: (v) => set({ showDocuments: v }),
  setShowDocManager: (v) => set({ showDocManager: v }),

  toggleShowReview: () => set((s) => ({ showReview: !s.showReview })),
  toggleShowComparison: () => set((s) => ({ showComparison: !s.showComparison })),
  toggleShowAudit: () => set((s) => ({ showAudit: !s.showAudit })),
  toggleShowMonteCarlo: () => set((s) => ({ showMonteCarlo: !s.showMonteCarlo })),
  toggleShowTornado: () => set((s) => ({ showTornado: !s.showTornado })),
  toggleShowTemplates: () => set((s) => ({ showTemplates: !s.showTemplates })),
  toggleShowInsights: () => set((s) => ({ showInsights: !s.showInsights })),
  toggleShowPeriods: () => set((s) => ({ showPeriods: !s.showPeriods })),
  toggleShowCharts: () => set((s) => ({ showCharts: !s.showCharts })),
  toggleShowSharing: () => set((s) => ({ showSharing: !s.showSharing })),
  toggleShowRoles: () => set((s) => ({ showRoles: !s.showRoles })),
  toggleShowDocuments: () => set((s) => ({ showDocuments: !s.showDocuments })),
  toggleShowDocManager: () => set((s) => ({ showDocManager: !s.showDocManager })),

  setPreloadedInsight: (v) => set({ preloadedInsight: v }),
  setPeriodData: (v) => set({ periodData: v }),
  setChartData: (v) => set({ chartData: v }),
  setPendingQuestions: (v) => set({ pendingQuestions: v }),
  setOnboardingStatus: (v) => set({ onboardingStatus: v }),
  bumpRefineKey: () => set((s) => ({ refineKey: s.refineKey + 1 })),
  setIsLoading: (v) => set({ isLoading: v }),
  setExpandedPanel: (v) => set({ expandedPanel: v }),
  setDimensionalPov: (v) => set({ dimensionalPov: v }),
  setDimensionalMetric: (v) => set({ dimensionalMetric: v }),

  closeAllPanels: () =>
    set({
      showReview: false,
      showComparison: false,
      showAudit: false,
      showMonteCarlo: false,
      showTornado: false,
      showTemplates: false,
      showInsights: false,
      preloadedInsight: null,
      showPeriods: false,
      periodData: null,
      showCharts: false,
      showSharing: false,
      showRoles: false,
      showDocuments: false,
      showDocManager: false,
      pendingQuestions: null,
      expandedPanel: null,
      dimensionalPov: {},
      dimensionalMetric: null,
    }),
}));
