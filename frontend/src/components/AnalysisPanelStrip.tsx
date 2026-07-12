"use client";

import { useEffect, useMemo } from "react";
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
import { AnalysisModal } from "./AnalysisModal";
import { getOnboardingStatus } from "@/lib/api";
import { setCurrency } from "@/lib/metrics";
import { useUiStore } from "@/stores/uiStore";

const CARD_COLORS: Record<string, string> = {
  review: "bg-accent", comparison: "bg-[var(--info)]", monteCarlo: "bg-accent",
  tornado: "bg-[var(--warning)]", attribution: "bg-[var(--success)]", driverTree: "bg-accent",
  goalSeek: "bg-[var(--info)]",
  versions: "bg-accent",
  actuals: "bg-[var(--success)]",
  whatIf: "bg-[var(--warning)]",
  periods: "bg-accent", charts: "bg-accent",
  sharing: "bg-[var(--info)]", audit: "bg-[var(--text-muted)]",
  templates: "bg-[var(--info)]", roles: "bg-[var(--warning)]",
  insights: "bg-[var(--success)]", followUp: "bg-accent",
  documents: "bg-[var(--info)]",
  docManager: "bg-accent",
};

interface AnalysisPanelStripProps {
  scenarioId?: string | null;
  isLoading: boolean;
  onApproved: () => void | Promise<void>;
  onFollowUpAnswers: (answers: { question_id: string; answer: string }[]) => void | Promise<void>;
  onTemplateCloned: (newScenarioId: string) => void;
}

export function AnalysisPanelStrip({
  scenarioId,
  isLoading,
  onApproved,
  onFollowUpAnswers,
  onTemplateCloned,
}: AnalysisPanelStripProps) {
  const {
    showReview, showComparison, showAudit, showMonteCarlo, showTornado,
    showAttribution, showDriverTree, showGoalSeek,
    showVersionHistory, showActualsCompare, showLiveWhatIf,
    showTemplates, showInsights, showPeriods, showCharts, showSharing,
    showRoles, showDocuments, showDocManager,
    preloadedInsight, periodData, chartData, pendingQuestions,
    refineKey, expandedPanel,
    setShowReview, setShowComparison, setShowAudit, setShowMonteCarlo,
    setShowTornado, setShowAttribution, setShowDriverTree, setShowGoalSeek,
    setShowVersionHistory, setShowActualsCompare, setShowLiveWhatIf,
    setShowTemplates, setShowInsights, setShowPeriods,
    setShowCharts, setShowSharing, setShowRoles, setShowDocuments,
    setShowDocManager,
    setPreloadedInsight, setPendingQuestions,
    setOnboardingStatus, setExpandedPanel,
  } = useUiStore();

  useEffect(() => {
    if (pendingQuestions && pendingQuestions.length > 0) {
      setExpandedPanel("followUp");
    }
  }, [pendingQuestions, setExpandedPanel]);

  const panelCards = useMemo(() => {
    const cards: { id: string; title: string; close: () => void }[] = [];
    if (showReview && scenarioId) cards.push({ id: "review", title: "Parameters", close: () => setShowReview(false) });
    if (showComparison && scenarioId) cards.push({ id: "comparison", title: "Comparison", close: () => setShowComparison(false) });
    if (showMonteCarlo && scenarioId) cards.push({ id: "monteCarlo", title: "Monte Carlo", close: () => setShowMonteCarlo(false) });
    if (showTornado && scenarioId) cards.push({ id: "tornado", title: "Sensitivity", close: () => setShowTornado(false) });
    if (showAttribution && scenarioId) cards.push({ id: "attribution", title: "Attribution", close: () => setShowAttribution(false) });
    if (showDriverTree && scenarioId) cards.push({ id: "driverTree", title: "Driver Tree", close: () => setShowDriverTree(false) });
    if (showGoalSeek && scenarioId) cards.push({ id: "goalSeek", title: "Goal Seek", close: () => setShowGoalSeek(false) });
    if (showVersionHistory && scenarioId) cards.push({ id: "versions", title: "Versions", close: () => setShowVersionHistory(false) });
    if (showActualsCompare && scenarioId) cards.push({ id: "actuals", title: "Actuals", close: () => setShowActualsCompare(false) });
    if (showLiveWhatIf && scenarioId) cards.push({ id: "whatIf", title: "What-If", close: () => setShowLiveWhatIf(false) });
    if (showPeriods && periodData) cards.push({ id: "periods", title: "Periods", close: () => setShowPeriods(false) });
    if (showCharts && chartData) cards.push({ id: "charts", title: "Charts", close: () => setShowCharts(false) });
    if (showSharing && scenarioId) cards.push({ id: "sharing", title: "Sharing", close: () => setShowSharing(false) });
    if (showAudit) cards.push({ id: "audit", title: "Audit Trail", close: () => setShowAudit(false) });
    if (showTemplates) cards.push({ id: "templates", title: "Templates", close: () => setShowTemplates(false) });
    if (showRoles) cards.push({ id: "roles", title: "Roles", close: () => setShowRoles(false) });
    if (showInsights && scenarioId) cards.push({ id: "insights", title: "Business Insights", close: () => { setShowInsights(false); setPreloadedInsight(null); } });
    if (pendingQuestions && pendingQuestions.length > 0 && scenarioId) cards.push({ id: "followUp", title: "Refine Scenario", close: () => setPendingQuestions(null) });
    if (showDocuments) cards.push({ id: "documents", title: "Documents", close: () => setShowDocuments(false) });
    if (showDocManager) cards.push({ id: "docManager", title: "Document Manager", close: () => setShowDocManager(false) });
    return cards;
  }, [
    showReview, showComparison, showMonteCarlo, showTornado, showAttribution, showDriverTree, showGoalSeek,
    showVersionHistory, showActualsCompare, showLiveWhatIf,
    showPeriods, showCharts,
    showSharing, showAudit, showTemplates, showRoles, showInsights, pendingQuestions,
    showDocuments, showDocManager, scenarioId, periodData, chartData,
    setShowReview, setShowComparison, setShowMonteCarlo, setShowTornado, setShowAttribution,
    setShowDriverTree, setShowGoalSeek, setShowVersionHistory, setShowActualsCompare, setShowLiveWhatIf,
    setShowPeriods,
    setShowCharts, setShowSharing, setShowAudit, setShowTemplates, setShowRoles,
    setShowInsights, setPreloadedInsight, setPendingQuestions, setShowDocuments, setShowDocManager,
  ]);

  const closePanel = (id: string, closeFn: () => void) => {
    closeFn();
    if (expandedPanel === id) setExpandedPanel(null);
  };

  const collapseModal = () => setExpandedPanel(null);

  const renderExpandedPanel = () => {
    const sid = scenarioId;
    switch (expandedPanel) {
      case "review":
        return sid ? <ParameterReview key={`pr-${sid}-${refineKey}`} scenarioId={sid} onApproved={onApproved} onClose={() => closePanel("review", () => setShowReview(false))} onMinimize={collapseModal} /> : null;
      case "comparison":
        return sid ? <ComparisonView currentScenarioId={sid} onClose={() => closePanel("comparison", () => setShowComparison(false))} onMinimize={collapseModal} /> : null;
      case "monteCarlo":
        return sid ? <MonteCarloView scenarioId={sid} onClose={() => closePanel("monteCarlo", () => setShowMonteCarlo(false))} onMinimize={collapseModal} /> : null;
      case "tornado":
        return sid ? <TornadoChart scenarioId={sid} onClose={() => closePanel("tornado", () => setShowTornado(false))} onMinimize={collapseModal} /> : null;
      case "attribution":
        return sid ? <AttributionView scenarioId={sid} onClose={() => closePanel("attribution", () => setShowAttribution(false))} onMinimize={collapseModal} /> : null;
      case "driverTree":
        return sid ? <DriverTreeView scenarioId={sid} onClose={() => closePanel("driverTree", () => setShowDriverTree(false))} onMinimize={collapseModal} /> : null;
      case "goalSeek":
        return sid ? <GoalSeekView scenarioId={sid} onClose={() => closePanel("goalSeek", () => setShowGoalSeek(false))} onMinimize={collapseModal} /> : null;
      case "versions":
        return sid ? <VersionHistoryPanel scenarioId={sid} onClose={() => closePanel("versions", () => setShowVersionHistory(false))} onMinimize={collapseModal} /> : null;
      case "actuals":
        return sid ? <ActualsCompareView scenarioId={sid} onClose={() => closePanel("actuals", () => setShowActualsCompare(false))} onMinimize={collapseModal} /> : null;
      case "whatIf":
        return sid ? <LiveWhatIfPanel scenarioId={sid} onClose={() => closePanel("whatIf", () => setShowLiveWhatIf(false))} onMinimize={collapseModal} /> : null;
      case "periods":
        return periodData ? <PeriodBreakdownView periods={periodData.periods} granularity={periodData.granularity} totalPl={periodData.pl} onClose={() => closePanel("periods", () => setShowPeriods(false))} onMinimize={collapseModal} /> : null;
      case "charts":
        return chartData ? <ScenarioCharts scenarioId={chartData.scenarioId ?? sid} pl={chartData.pl} basePl={chartData.basePl} periods={chartData.periods} granularity={chartData.granularity} dimensional={chartData.dimensional} onClose={() => closePanel("charts", () => setShowCharts(false))} onMinimize={collapseModal} /> : null;
      case "sharing":
        return sid ? <SharingPanel scenarioId={sid} onClose={() => closePanel("sharing", () => setShowSharing(false))} onMinimize={collapseModal} /> : null;
      case "audit":
        return <AuditTrailViewer scenarioId={sid ?? undefined} onClose={() => closePanel("audit", () => setShowAudit(false))} onMinimize={collapseModal} />;
      case "templates":
        return <TemplateGallery scenarioId={sid ?? undefined} onCloned={onTemplateCloned} onClose={() => closePanel("templates", () => setShowTemplates(false))} onMinimize={collapseModal} />;
      case "roles":
        return <RoleManagement onClose={() => closePanel("roles", () => setShowRoles(false))} onMinimize={collapseModal} />;
      case "insights":
        return sid ? <BusinessInsights scenarioId={sid} preloaded={preloadedInsight} onClose={() => closePanel("insights", () => { setShowInsights(false); setPreloadedInsight(null); })} onMinimize={collapseModal} /> : null;
      case "followUp":
        return pendingQuestions && pendingQuestions.length > 0 ? <FollowUpQuestions questions={pendingQuestions} onSubmit={onFollowUpAnswers} isLoading={isLoading} /> : null;
      case "documents":
        return <DocumentPanel onClose={() => closePanel("documents", () => setShowDocuments(false))} onMinimize={collapseModal} />;
      case "docManager":
        return <DocumentManager onClose={() => closePanel("docManager", () => setShowDocManager(false))} onMinimize={collapseModal} onContextBuilt={() => { getOnboardingStatus().then((s) => { setOnboardingStatus(s); if (s.currency) setCurrency(s.currency, s.currency_unit); }).catch(() => {}); }} />;
      default:
        return null;
    }
  };

  return (
    <>
      {panelCards.length > 0 && (
        <div className="px-3 py-2 border-t border-[var(--border)] bg-[var(--panel-bg)]/60 flex gap-2 overflow-x-auto shrink-0">
          {panelCards.map((card) => (
            <div
              key={card.id}
              className={`flex items-center gap-2 pl-2.5 pr-1.5 py-1.5 rounded-lg border text-xs font-medium transition-all group shrink-0 ${
                expandedPanel === card.id
                  ? "bg-accent/10 border-accent/30 text-accent shadow-sm ring-1 ring-accent/20"
                  : "border-[var(--border)] bg-[var(--card-bg)] text-[var(--text-primary)] hover:border-[var(--panel-border)] hover:shadow-card"
              }`}
            >
              <button
                type="button"
                onClick={() => setExpandedPanel(expandedPanel === card.id ? null : card.id)}
                className="flex items-center gap-2 min-w-0"
              >
                <span className={`w-2 h-2 rounded-full shrink-0 ${CARD_COLORS[card.id] || "bg-accent"}`} />
                <span className="whitespace-nowrap">{card.title}</span>
              </button>
              <button
                type="button"
                onClick={() => closePanel(card.id, card.close)}
                className="ml-1 w-4 h-4 rounded flex items-center justify-center opacity-0 group-hover:opacity-100 text-[var(--text-faint)] hover:text-[var(--danger)] hover:bg-[var(--danger-bg)] transition-all"
                aria-label={`Remove ${card.title}`}
                title="Remove"
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}

      {expandedPanel && (
        <AnalysisModal onCollapse={() => setExpandedPanel(null)} title={panelCards.find((c) => c.id === expandedPanel)?.title}>
          {renderExpandedPanel()}
        </AnalysisModal>
      )}
    </>
  );
}
