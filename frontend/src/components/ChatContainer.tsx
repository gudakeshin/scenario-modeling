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
import { TradingWindowBanner } from "./TradingWindowBanner";
import { PanelMenu } from "./PanelMenu";
import { APP_SHELL_ID } from "./AnalysisModal";
import { PANELS, PANEL_GROUPS, isPanelAvailable, type PanelDef, type PanelId } from "@/lib/panels";

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

  // Narrow selectors — destructuring the whole store re-rendered this
  // component (and the modal below it) on every unrelated UI change.
  const openPanels = useUiStore((s) => s.openPanels);
  const periodData = useUiStore((s) => s.periodData);
  const chartData = useUiStore((s) => s.chartData);
  const togglePanel = useUiStore((s) => s.togglePanel);
  const openPanel = useUiStore((s) => s.openPanel);

  const assistantMode = useChatStore((s) => s.assistantMode);

  const availability = {
    hasScenario: Boolean(active?.scenarioId),
    hasPeriodData: Boolean(periodData),
    hasChartData: Boolean(chartData),
  };

  const available = (p: PanelDef) => isPanelAvailable(p, availability);
  const isOpen = (id: PanelId) => openPanels.includes(id);

  /** Labels stay stable; open state is carried by aria-pressed + styling. */
  const actionBtn = (isActive: boolean) =>
    `rounded-xl border px-3 py-1.5 text-xs font-medium transition-all ${
      isActive
        ? "bg-accent/10 border-accent/30 text-accent shadow-sm"
        : "border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--panel-bg)] hover:border-[var(--panel-border)] hover:shadow-card"
    } disabled:opacity-40`;

  const reviewPanel = PANELS.find((p) => p.id === "review")!;
  const insightsPanel = PANELS.find((p) => p.id === "insights")!;

  const menuItems = (group: Exclude<PanelDef["group"], null>) =>
    PANELS.filter((p) => p.group === group && !p.primary && available(p));

  return (
    <div id={APP_SHELL_ID} className="flex h-[100dvh] overflow-hidden bg-background">
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
        <TradingWindowBanner />

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
                onClick={() => openPanel("docManager")}
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

          {/* ── Action bar ── 7 controls, derived from the panel registry */}
          {active?.scenarioId && (
            <div className="px-4 py-2.5 border-t border-[var(--border)] bg-[var(--panel-bg)] flex flex-wrap items-center justify-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => togglePanel(reviewPanel.id)}
                disabled={isLoading}
                aria-pressed={isOpen(reviewPanel.id)}
                className={actionBtn(isOpen(reviewPanel.id))}
              >
                {reviewPanel.actionLabel}
              </button>

              {PANEL_GROUPS.map((g) => (
                <PanelMenu
                  key={g.id}
                  label={g.label}
                  items={menuItems(g.id)}
                  openPanels={openPanels}
                  isLoading={isLoading}
                  onToggle={togglePanel}
                />
              ))}

              <button
                type="button"
                onClick={() => togglePanel(insightsPanel.id)}
                disabled={isLoading}
                aria-pressed={isOpen(insightsPanel.id)}
                className={`rounded-xl border px-3 py-1.5 text-xs font-semibold transition-all ${
                  isOpen(insightsPanel.id)
                    ? "bg-accent text-white border-accent shadow-sm"
                    : "bg-accent/10 border-accent/30 text-accent hover:bg-accent/20"
                } disabled:opacity-40`}
              >
                {insightsPanel.actionLabel}
              </button>

              <ExportControls scenarioId={active.scenarioId} />
            </div>
          )}

          {/* Pre-scenario: only the entry points that work without a run */}
          {!active?.scenarioId && (
            <div className="px-4 py-2.5 border-t border-[var(--border)] bg-[var(--panel-bg)] flex flex-wrap justify-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => togglePanel("docManager")}
                aria-pressed={isOpen("docManager")}
                className={`rounded-xl border px-4 py-2 text-sm font-medium transition-all ${
                  !onboardingStatus?.ready && !isOpen("docManager")
                    ? "bg-accent text-white border-accent hover:bg-accent/90"
                    : isOpen("docManager")
                    ? "bg-accent/10 border-accent/30 text-accent shadow-sm"
                    : "border-[var(--border)] text-[var(--text-secondary)] hover:bg-background hover:shadow-card"
                }`}
              >
                Document Manager
              </button>
              <button
                type="button"
                onClick={() => togglePanel("templates")}
                aria-pressed={isOpen("templates")}
                className={`rounded-xl border px-4 py-2 text-sm font-medium transition-all ${
                  isOpen("templates")
                    ? "bg-accent/10 border-accent/30 text-accent shadow-sm"
                    : "border-[var(--border)] text-[var(--text-secondary)] hover:bg-background hover:shadow-card"
                }`}
              >
                Browse Templates
              </button>
              <button
                type="button"
                onClick={() => togglePanel("documents")}
                aria-pressed={isOpen("documents")}
                className={`rounded-xl border px-4 py-2 text-sm font-medium transition-all ${
                  isOpen("documents")
                    ? "bg-accent/10 border-accent/30 text-accent shadow-sm"
                    : "border-[var(--border)] text-[var(--text-secondary)] hover:bg-background hover:shadow-card"
                }`}
              >
                Talk to Documents
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
