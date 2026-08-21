"use client";

import { useCallback, useMemo } from "react";
import { ParameterReview } from "./ParameterReview";
import { ComparisonView } from "./ComparisonView";
import { AuditTrailViewer } from "./AuditTrailViewer";
import { MonteCarloView } from "./MonteCarloView";
import { TornadoChart } from "./TornadoChart";
import { AttributionView } from "./AttributionView";
import { DriverTreeView } from "./DriverTreeView";
import { GoalSeekView } from "./GoalSeekView";
import { VersionHistoryPanel } from "./VersionHistoryPanel";
import { ActualsCompareView } from "./ActualsCompareView";
import { LiveWhatIfPanel } from "./LiveWhatIfPanel";
import { TemplateGallery } from "./TemplateGallery";
import { BusinessInsights } from "./BusinessInsights";
import { PeriodBreakdownView } from "./PeriodBreakdownView";
import { ScenarioCharts } from "./ScenarioCharts";
import { SharingPanel } from "./SharingPanel";
import { RoleManagement } from "./RoleManagement";
import { FollowUpQuestions } from "./FollowUpQuestions";
import { DocumentPanel } from "./DocumentPanel";
import { DocumentManager } from "./DocumentManager";
import { FidelityReport } from "./FidelityReport";
import { AnalysisModal } from "./AnalysisModal";
import { getOnboardingStatus, type FollowUpAnswer } from "@/lib/api";
import { setCurrency } from "@/lib/metrics";
import { useUiStore } from "@/stores/uiStore";
import { getPanel, isPanelAvailable, panelDot, panelTitle, type PanelId } from "@/lib/panels";

interface AnalysisPanelStripProps {
  scenarioId?: string | null;
  isLoading: boolean;
  onApproved: () => void | Promise<void>;
  onFollowUpAnswers: (answers: FollowUpAnswer[]) => void | Promise<void>;
  onTemplateCloned: (newScenarioId: string) => void;
}

export function AnalysisPanelStrip({
  scenarioId,
  isLoading,
  onApproved,
  onFollowUpAnswers,
  onTemplateCloned,
}: AnalysisPanelStripProps) {
  // Narrow selectors — subscribing to the whole store made this component
  // re-render on every unrelated UI change, which was stealing modal focus.
  const openPanels = useUiStore((s) => s.openPanels);
  const expandedPanel = useUiStore((s) => s.expandedPanel);
  const preloadedInsight = useUiStore((s) => s.preloadedInsight);
  const periodData = useUiStore((s) => s.periodData);
  const chartData = useUiStore((s) => s.chartData);
  const pendingQuestions = useUiStore((s) => s.pendingQuestions);
  const refineKey = useUiStore((s) => s.refineKey);
  const closePanel = useUiStore((s) => s.closePanel);
  const setExpandedPanel = useUiStore((s) => s.setExpandedPanel);
  const setPreloadedInsight = useUiStore((s) => s.setPreloadedInsight);
  const setOnboardingStatus = useUiStore((s) => s.setOnboardingStatus);

  const availability = useMemo(
    () => ({
      hasScenario: Boolean(scenarioId),
      hasPeriodData: Boolean(periodData),
      hasChartData: Boolean(chartData),
    }),
    [scenarioId, periodData, chartData],
  );

  /** Open panels whose backing data still exists, follow-up first. */
  const visiblePanels = useMemo(() => {
    const ids = openPanels.filter((id) => {
      const def = getPanel(id);
      return def ? isPanelAvailable(def, availability) : false;
    });
    // Follow-up takes visual priority among interactive panels.
    return ids.sort((a, b) => Number(b === "followUp") - Number(a === "followUp"));
  }, [openPanels, availability]);

  // Stable identity — AnalysisModal must not re-run its focus effect on every
  // render of this component.
  const collapseModal = useCallback(() => setExpandedPanel(null), [setExpandedPanel]);

  const handleContextBuilt = useCallback(() => {
    getOnboardingStatus()
      .then((s) => {
        setOnboardingStatus(s);
        if (s.currency) setCurrency(s.currency, s.currency_unit ?? undefined);
      })
      .catch(() => {});
  }, [setOnboardingStatus]);

  const renderExpandedPanel = () => {
    const sid = scenarioId;
    const close = (id: PanelId) => () => closePanel(id);

    switch (expandedPanel) {
      case "review":
        return sid ? <ParameterReview key={`pr-${sid}-${refineKey}`} scenarioId={sid} onApproved={onApproved} onClose={close("review")} onMinimize={collapseModal} /> : null;
      case "comparison":
        return sid ? <ComparisonView currentScenarioId={sid} onClose={close("comparison")} onMinimize={collapseModal} /> : null;
      case "monteCarlo":
        return sid ? <MonteCarloView scenarioId={sid} onClose={close("monteCarlo")} onMinimize={collapseModal} /> : null;
      case "tornado":
        return sid ? <TornadoChart scenarioId={sid} onClose={close("tornado")} onMinimize={collapseModal} /> : null;
      case "attribution":
        return sid ? <AttributionView scenarioId={sid} onClose={close("attribution")} onMinimize={collapseModal} /> : null;
      case "driverTree":
        return sid ? <DriverTreeView scenarioId={sid} onClose={close("driverTree")} onMinimize={collapseModal} /> : null;
      case "goalSeek":
        return sid ? <GoalSeekView scenarioId={sid} onClose={close("goalSeek")} onMinimize={collapseModal} /> : null;
      case "fidelity":
        return sid ? <FidelityReport scenarioId={sid} onClose={close("fidelity")} onMinimize={collapseModal} /> : null;
      case "versions":
        return sid ? <VersionHistoryPanel scenarioId={sid} onClose={close("versions")} onMinimize={collapseModal} /> : null;
      case "actuals":
        return sid ? <ActualsCompareView scenarioId={sid} onClose={close("actuals")} onMinimize={collapseModal} /> : null;
      case "whatIf":
        return sid ? <LiveWhatIfPanel scenarioId={sid} onClose={close("whatIf")} onMinimize={collapseModal} /> : null;
      case "periods":
        return periodData ? <PeriodBreakdownView periods={periodData.periods} granularity={periodData.granularity} totalPl={periodData.pl} onClose={close("periods")} onMinimize={collapseModal} /> : null;
      case "charts":
        return chartData ? <ScenarioCharts scenarioId={chartData.scenarioId ?? sid} pl={chartData.pl} basePl={chartData.basePl} periods={chartData.periods} granularity={chartData.granularity} dimensional={chartData.dimensional} onClose={close("charts")} onMinimize={collapseModal} /> : null;
      case "sharing":
        return sid ? <SharingPanel scenarioId={sid} onClose={close("sharing")} onMinimize={collapseModal} /> : null;
      case "audit":
        return <AuditTrailViewer scenarioId={sid ?? undefined} onClose={close("audit")} onMinimize={collapseModal} />;
      case "templates":
        return <TemplateGallery scenarioId={sid ?? undefined} onCloned={onTemplateCloned} onClose={close("templates")} onMinimize={collapseModal} />;
      case "roles":
        return <RoleManagement onClose={close("roles")} onMinimize={collapseModal} />;
      case "insights":
        return sid ? (
          <BusinessInsights
            scenarioId={sid}
            preloaded={preloadedInsight}
            onInsightChange={setPreloadedInsight}
            onClose={close("insights")}
            onMinimize={collapseModal}
          />
        ) : null;
      case "followUp":
        return pendingQuestions && pendingQuestions.length > 0 ? (
          <FollowUpQuestions
            questions={pendingQuestions}
            onSubmit={onFollowUpAnswers}
            isLoading={isLoading}
            onClose={close("followUp")}
            onMinimize={collapseModal}
          />
        ) : null;
      case "documents":
        return <DocumentPanel onClose={close("documents")} onMinimize={collapseModal} />;
      case "docManager":
        return <DocumentManager onClose={close("docManager")} onMinimize={collapseModal} onContextBuilt={handleContextBuilt} />;
      default:
        return null;
    }
  };

  return (
    <>
      {visiblePanels.length > 0 && (
        <div
          className="px-3 py-2 border-t border-[var(--border)] bg-[var(--panel-bg)]/60 flex gap-2 overflow-x-auto shrink-0 relative z-10"
          role="group"
          aria-label="Open panels"
        >
          {visiblePanels.map((id) => {
            const title = panelTitle(id);
            const isExpanded = expandedPanel === id;
            return (
              <div
                key={id}
                className={`flex items-center gap-2 pl-2.5 pr-1.5 py-1.5 rounded-lg border text-xs font-medium transition-all group shrink-0 ${
                  isExpanded
                    ? "bg-accent/10 border-accent/30 text-accent shadow-sm ring-1 ring-accent/20"
                    : "border-[var(--border)] bg-[var(--card-bg)] text-[var(--text-primary)] hover:border-[var(--panel-border)] hover:shadow-card"
                }`}
              >
                <button
                  type="button"
                  onClick={() => setExpandedPanel(isExpanded ? null : id)}
                  className="flex items-center gap-2 min-w-0"
                  aria-expanded={isExpanded}
                >
                  <span className={`w-2 h-2 rounded-full shrink-0 ${panelDot(id)}`} aria-hidden="true" />
                  <span className="whitespace-nowrap">{title}</span>
                </button>
                <button
                  type="button"
                  onClick={() => closePanel(id)}
                  /* focus-visible/focus-within keep this reachable for keyboard
                     users — group-hover alone left it invisible. */
                  className="ml-1 w-4 h-4 rounded flex items-center justify-center opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 text-[var(--text-faint)] hover:text-[var(--danger)] hover:bg-[var(--danger-bg)] transition-all"
                  aria-label={`Close ${title}`}
                  title={`Close ${title}`}
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
                    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>
            );
          })}
        </div>
      )}

      {expandedPanel && (
        <AnalysisModal onCollapse={collapseModal} title={panelTitle(expandedPanel)}>
          {renderExpandedPanel()}
        </AnalysisModal>
      )}
    </>
  );
}
