"use client";

import { useEffect, useState } from "react";
import { Sidebar } from "./Sidebar";
import { MessageList } from "./MessageList";
import { ChatComposer } from "./ChatComposer";
import { ExportControls } from "./ExportControls";
import { AnalysisPanelStrip } from "./AnalysisPanelStrip";
import { RoleSwitcher } from "./RoleSwitcher";
import { useScenarioWorkflow } from "@/hooks/useScenarioWorkflow";
import { useUiStore } from "@/stores/uiStore";
import { useChatStore } from "@/stores/chatStore";
import { strings } from "@/lib/strings";
import { getAgentStatus, type AgentStatus } from "@/lib/api";

export function ChatContainer() {
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [agentStatus, setAgentStatus] = useState<AgentStatus | null>(null);

  const {
    conversations,
    activeId,
    active,
    messages,
    sessionId,
    isLoading,
    onboardingStatus,
    handleNewChat,
    handleSelect,
    handleRename,
    handleDelete,
    handleDeleteMany,
    handleSend,
    handleApproved,
    handleFollowUpAnswers,
    handleTemplateCloned,
  } = useScenarioWorkflow();

  useEffect(() => {
    let cancelled = false;
    getAgentStatus()
      .then((s) => {
        if (!cancelled) setAgentStatus(s);
      })
      .catch(() => {
        /* non-fatal */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const {
    showReview, showComparison, showAudit, showMonteCarlo, showTornado,
    showAttribution, showDriverTree, showGoalSeek, showFidelity,
    showVersionHistory, showActualsCompare, showLiveWhatIf,
    showTemplates, showInsights, showPeriods, showCharts, showSharing,
    showRoles, showDocuments, showDocManager,
    periodData, chartData, expandedPanel,
    setShowReview, setShowComparison, setShowAudit, setShowMonteCarlo,
    setShowTornado, setShowAttribution, setShowDriverTree, setShowGoalSeek,
    setShowFidelity,
    setShowVersionHistory, setShowActualsCompare, setShowLiveWhatIf,
    setShowTemplates, setShowInsights, setShowPeriods,
    setShowCharts, setShowSharing, setShowRoles, setShowDocuments,
    setShowDocManager, setExpandedPanel,
  } = useUiStore();

  const assistantMode = useChatStore((s) => s.assistantMode);

  // Toggle helper: activate+expand or deactivate+collapse
  const tp = (id: string, show: boolean, setShow: (v: boolean) => void) => () => {
    if (show) {
      setShow(false);
      if (expandedPanel === id) setExpandedPanel(null);
    } else {
      setShow(true);
      setExpandedPanel(id);
    }
  };

  const actionBtn = (isActive: boolean) =>
    `rounded-xl border px-3 py-1.5 text-xs font-medium transition-all ${
      isActive
        ? "bg-accent/10 border-accent/30 text-accent shadow-sm"
        : "border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--panel-bg)] hover:border-[var(--panel-border)] hover:shadow-card"
    } disabled:opacity-40`;

  return (
    <div className="flex h-[100dvh] overflow-hidden bg-background">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:top-2 focus:left-2 focus:rounded-lg focus:bg-accent focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-white focus:shadow-panel"
      >
        {strings.app.skipToContent}
      </a>

      <Sidebar
        conversations={conversations}
        activeId={activeId}
        onSelect={handleSelect}
        onNewChat={handleNewChat}
        onRename={handleRename}
        onDelete={handleDelete}
        onDeleteMany={handleDeleteMany}
        mobileOpen={mobileSidebarOpen}
        onMobileClose={() => setMobileSidebarOpen(false)}
      />

      <div className="flex flex-col flex-1 min-w-0 relative">
        {/* Top bar with role switcher */}
        <div className="flex items-center justify-between px-4 py-2 border-b border-[var(--border)] bg-[var(--card-bg)]/80 backdrop-blur-sm shrink-0">
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="md:hidden p-1.5 rounded-lg text-[var(--text-secondary)] hover:bg-[var(--panel-bg)] hover:text-[var(--text-primary)] transition-colors"
              aria-label={strings.sidebar.openMenu}
              onClick={() => setMobileSidebarOpen(true)}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <line x1="3" y1="6" x2="21" y2="6" />
                <line x1="3" y1="12" x2="21" y2="12" />
                <line x1="3" y1="18" x2="21" y2="18" />
              </svg>
            </button>
            <h1 className="text-sm font-semibold text-[var(--text-primary)]">{strings.app.name}</h1>
          </div>
          <div className="flex items-center gap-3">
            {agentStatus && !agentStatus.ready && (
              <span
                className="hidden sm:inline text-[11px] text-[var(--text-muted)] max-w-[220px] truncate"
                title={agentStatus.reasons.join(" · ")}
              >
                Agent: {agentStatus.enabled ? "needs validated model" : "off"}
              </span>
            )}
            {agentStatus?.ready && (
              <span className="hidden sm:inline text-[11px] text-accent">Agent ready</span>
            )}
            <RoleSwitcher />
          </div>
        </div>

        <main id="main-content" className="flex flex-col flex-1 min-h-0 min-w-0 overflow-hidden">
          {/* Onboarding banner */}
          {onboardingStatus && !onboardingStatus.ready && messages.length === 0 && !active?.scenarioId && (
            <div className="mx-4 mt-4 rounded-xl border border-accent/20 bg-accent/5 p-5 space-y-3">
              <h3 className="text-lg font-semibold text-[var(--text-primary)]">Welcome to Scenario Modeling</h3>
              <p className="text-sm text-[var(--text-secondary)]">
                Get started by uploading your financial documents. The AI will analyze them to understand your business and create a custom financial model.
              </p>
              <div className="flex items-center gap-3">
                <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${onboardingStatus.has_context ? "bg-[var(--success)] text-white" : "bg-[var(--border)] text-[var(--text-muted)]"}`}>1</div>
                <span className="text-sm text-[var(--text-primary)]">Upload documents {onboardingStatus.has_context && <span className="text-[var(--success)]">(done)</span>}</span>
              </div>
              <div className="flex items-center gap-3">
                <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${onboardingStatus.has_context ? "bg-[var(--success)] text-white" : "bg-[var(--border)] text-[var(--text-muted)]"}`}>2</div>
                <span className="text-sm text-[var(--text-primary)]">Build context {onboardingStatus.has_context && <span className="text-[var(--success)]">(done — {onboardingStatus.company_name})</span>}</span>
              </div>
              <div className="flex items-center gap-3">
                <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${onboardingStatus.has_model ? "bg-[var(--success)] text-white" : "bg-[var(--border)] text-[var(--text-muted)]"}`}>3</div>
                <span className="text-sm text-[var(--text-primary)]">Review model {onboardingStatus.has_model && <span className="text-[var(--success)]">(done — {onboardingStatus.model_name})</span>}</span>
              </div>
              <button
                type="button"
                onClick={() => { setShowDocManager(true); setExpandedPanel("docManager"); }}
                className="mt-2 px-5 py-2.5 rounded-xl bg-accent text-white text-sm font-semibold hover:bg-accent/90 transition-colors"
              >
                Open Document Manager
              </button>
            </div>
          )}

          {/* Scrollable message stage — composer/toolbar stay pinned below */}
          <div className="flex flex-col flex-1 min-h-0 relative overflow-hidden">
            <MessageList messages={messages} isLoading={isLoading} />

            <AnalysisPanelStrip
              scenarioId={active?.scenarioId}
              isLoading={isLoading}
              onApproved={handleApproved}
              onFollowUpAnswers={handleFollowUpAnswers}
              onTemplateCloned={handleTemplateCloned}
            />
          </div>

          {/* ── Action bar ── */}
          {active?.scenarioId && (
            <div className="px-4 py-2.5 border-t border-[var(--border)] bg-[var(--panel-bg)] flex flex-wrap items-center justify-center gap-2 shrink-0">
              <button type="button" onClick={tp("review", showReview, setShowReview)} disabled={isLoading} className={actionBtn(showReview)}>
                {showReview ? "Hide Review" : "Review Parameters"}
              </button>
              <button type="button" onClick={tp("comparison", showComparison, setShowComparison)} disabled={isLoading} className={actionBtn(showComparison)}>
                {showComparison ? "Hide Compare" : "Compare"}
              </button>
              <button type="button" onClick={tp("monteCarlo", showMonteCarlo, setShowMonteCarlo)} disabled={isLoading} className={actionBtn(showMonteCarlo)}>
                {showMonteCarlo ? "Hide MC" : "Monte Carlo"}
              </button>
              <button type="button" onClick={tp("tornado", showTornado, setShowTornado)} disabled={isLoading} className={actionBtn(showTornado)}>
                {showTornado ? "Hide Tornado" : "Sensitivity"}
              </button>
              <button type="button" onClick={tp("attribution", showAttribution, setShowAttribution)} disabled={isLoading} className={actionBtn(showAttribution)}>
                {showAttribution ? "Hide Attribution" : "Attribution"}
              </button>
              <button type="button" onClick={tp("driverTree", showDriverTree, setShowDriverTree)} disabled={isLoading} className={actionBtn(showDriverTree)}>
                {showDriverTree ? "Hide Drivers" : "Driver Tree"}
              </button>
              <button type="button" onClick={tp("goalSeek", showGoalSeek, setShowGoalSeek)} disabled={isLoading} className={actionBtn(showGoalSeek)}>
                {showGoalSeek ? "Hide Goal Seek" : "Goal Seek"}
              </button>
              <button type="button" onClick={tp("fidelity", showFidelity, setShowFidelity)} disabled={isLoading} className={actionBtn(showFidelity)}>
                {showFidelity ? "Hide Fidelity" : "Audit Fidelity"}
              </button>
              <button type="button" onClick={tp("versions", showVersionHistory, setShowVersionHistory)} disabled={isLoading} className={actionBtn(showVersionHistory)}>
                {showVersionHistory ? "Hide Versions" : "Versions"}
              </button>
              <button type="button" onClick={tp("actuals", showActualsCompare, setShowActualsCompare)} disabled={isLoading} className={actionBtn(showActualsCompare)}>
                {showActualsCompare ? "Hide Actuals" : "Actuals"}
              </button>
              <button type="button" onClick={tp("whatIf", showLiveWhatIf, setShowLiveWhatIf)} disabled={isLoading} className={actionBtn(showLiveWhatIf)}>
                {showLiveWhatIf ? "Hide What-If" : "What-If"}
              </button>
              {periodData && (
                <button type="button" onClick={tp("periods", showPeriods, setShowPeriods)} disabled={isLoading} className={actionBtn(showPeriods)}>
                  {showPeriods ? "Hide Periods" : "Periods"}
                </button>
              )}
              {chartData && (
                <button type="button" onClick={tp("charts", showCharts, setShowCharts)} disabled={isLoading} className={actionBtn(showCharts)}>
                  {showCharts ? "Hide Charts" : "Charts"}
                </button>
              )}
              <button type="button" onClick={tp("sharing", showSharing, setShowSharing)} disabled={isLoading} className={actionBtn(showSharing)}>
                {showSharing ? "Hide Sharing" : "Share"}
              </button>
              <button type="button" onClick={tp("audit", showAudit, setShowAudit)} className={actionBtn(showAudit)}>
                {showAudit ? "Hide Audit" : "Audit"}
              </button>
              <button type="button" onClick={tp("templates", showTemplates, setShowTemplates)} className={actionBtn(showTemplates)}>
                {showTemplates ? "Hide Templates" : "Templates"}
              </button>
              <button type="button" onClick={tp("roles", showRoles, setShowRoles)} className={actionBtn(showRoles)}>
                {showRoles ? "Hide Roles" : "Roles"}
              </button>
              <button type="button" onClick={tp("documents", showDocuments, setShowDocuments)} className={actionBtn(showDocuments)}>
                {showDocuments ? "Hide Docs" : "Documents"}
              </button>
              <button type="button" onClick={tp("docManager", showDocManager, setShowDocManager)} className={actionBtn(showDocManager)}>
                {showDocManager ? "Hide Document Manager" : "Document Manager"}
              </button>
              <button
                type="button"
                onClick={() => {
                  if (showInsights) {
                    setShowInsights(false);
                    if (expandedPanel === "insights") setExpandedPanel(null);
                  } else {
                    setShowInsights(true);
                    setExpandedPanel("insights");
                  }
                }}
                disabled={isLoading}
                className={`rounded-xl border px-3 py-1.5 text-xs font-semibold transition-all ${
                  showInsights
                    ? "bg-accent text-white border-accent shadow-sm"
                    : "bg-accent/10 border-accent/30 text-accent hover:bg-accent/20"
                } disabled:opacity-40`}
              >
                {showInsights ? "Hide Insights" : "So What?"}
              </button>
              <ExportControls scenarioId={active.scenarioId} />
            </div>
          )}

          {/* Template, Documents & Manager buttons when no scenario active */}
          {!active?.scenarioId && (
            <div className="px-4 py-2.5 border-t border-[var(--border)] bg-[var(--panel-bg)] flex justify-center gap-2 shrink-0">
              <button
                type="button"
                onClick={tp("docManager", showDocManager, setShowDocManager)}
                className={`rounded-xl border px-4 py-2 text-sm font-medium transition-all ${
                  !onboardingStatus?.ready
                    ? "bg-accent text-white border-accent hover:bg-accent/90"
                    : "border-[var(--border)] text-[var(--text-secondary)] hover:bg-background hover:shadow-card"
                }`}
              >
                {showDocManager ? "Hide Manager" : "Document Manager"}
              </button>
              <button
                type="button"
                onClick={() => {
                  if (showTemplates) {
                    setShowTemplates(false);
                    if (expandedPanel === "templates") setExpandedPanel(null);
                  } else {
                    setShowTemplates(true);
                    setExpandedPanel("templates");
                  }
                }}
                className="rounded-xl border border-[var(--border)] px-4 py-2 text-sm font-medium text-[var(--text-secondary)] hover:bg-background hover:shadow-card transition-all"
              >
                {showTemplates ? "Hide Templates" : "Browse Templates"}
              </button>
              <button
                type="button"
                onClick={tp("documents", showDocuments, setShowDocuments)}
                className="rounded-xl border border-[var(--border)] px-4 py-2 text-sm font-medium text-[var(--text-secondary)] hover:bg-background hover:shadow-card transition-all"
              >
                {showDocuments ? "Hide Documents" : "Talk to Documents"}
              </button>
            </div>
          )}

          <ChatComposer
            onSend={handleSend}
            disabled={isLoading}
            placeholder={
              assistantMode === "documents"
                ? strings.chat.placeholderDocuments
                : sessionId
                ? strings.chat.placeholderFollowUp
                : onboardingStatus && !onboardingStatus.ready
                ? strings.chat.placeholderOnboarding
                : strings.chat.placeholder
            }
          />
        </main>
      </div>
    </div>
  );
}
