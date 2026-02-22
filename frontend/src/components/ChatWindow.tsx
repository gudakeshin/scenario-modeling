"use client";

import { useState, useCallback, useEffect, useMemo } from "react";
import { Sidebar } from "./Sidebar";
import { MessageList } from "./MessageList";
import { ChatComposer } from "./ChatComposer";
import { ParameterReview } from "./ParameterReview";
import { ComparisonView } from "./ComparisonView";
import { ExportControls } from "./ExportControls";
import { AuditTrailViewer } from "./AuditTrailViewer";
import { MonteCarloView } from "./MonteCarloView";
import { TornadoChart } from "./TornadoChart";
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
import { RoleSwitcher } from "./RoleSwitcher";
import {
  parseScenario,
  refineScenario,
  runScenario,
  generateNarrative,
  generateBusinessAnalysis,
  createSession,
  addFollowUp,
  getBaseCase,
  initUserContext,
  listScenarios,
  getOnboardingStatus,
  type BusinessInsight,
  type PeriodResult,
  type FollowUpQuestion,
  type OnboardingStatus,
} from "@/lib/api";
import { setCurrency, getCurrencySymbol, getCurrencyLabel } from "@/lib/metrics";
import type { Message, Conversation, ThinkingData } from "@/types/chat";

function generateId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function firstLine(text: string, maxLen = 50) {
  const line = text.split(/\n/)[0]?.trim() || "";
  return line.length > maxLen ? line.slice(0, maxLen) + "\u2026" : line;
}

export function ChatWindow() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [showReview, setShowReview] = useState(false);
  const [showComparison, setShowComparison] = useState(false);
  const [showAudit, setShowAudit] = useState(false);
  const [showMonteCarlo, setShowMonteCarlo] = useState(false);
  const [showTornado, setShowTornado] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);
  const [showInsights, setShowInsights] = useState(false);
  const [preloadedInsight, setPreloadedInsight] = useState<BusinessInsight | null>(null);
  const [showPeriods, setShowPeriods] = useState(false);
  const [periodData, setPeriodData] = useState<{ periods: PeriodResult[]; granularity: "monthly" | "quarterly"; pl: Record<string, number> } | null>(null);
  const [showCharts, setShowCharts] = useState(false);
  const [chartData, setChartData] = useState<{ pl: Record<string, number>; basePl?: Record<string, number>; periods?: PeriodResult[]; granularity?: "monthly" | "quarterly" } | null>(null);
  const [showSharing, setShowSharing] = useState(false);
  const [showRoles, setShowRoles] = useState(false);
  const [showDocuments, setShowDocuments] = useState(false);
  const [showDocManager, setShowDocManager] = useState(false);

  // Onboarding: check if the user has context + model
  const [onboardingStatus, setOnboardingStatus] = useState<OnboardingStatus | null>(null);

  // Follow-up questions from the parser (interactive disambiguation)
  const [pendingQuestions, setPendingQuestions] = useState<FollowUpQuestion[] | null>(null);

  // Increment to force ParameterReview to re-mount and re-fetch after refinement
  const [paramRefreshKey, setParamRefreshKey] = useState(0);

  // Which panel is currently expanded in the modal (null = all collapsed to cards)
  const [expandedPanel, setExpandedPanel] = useState<string | null>(null);

  // Session ID for conversational follow-up
  const [sessionId, setSessionId] = useState<string | null>(null);

  // Initialize user context on mount (resolves cached user identity) + check onboarding
  useEffect(() => {
    initUserContext().catch(() => {});
    getOnboardingStatus().then((s) => {
      setOnboardingStatus(s);
      if (s.currency) setCurrency(s.currency, s.currency_unit);
    }).catch(() => {});
  }, []);

  // Load existing scenarios from the database on mount so they persist across navigation
  useEffect(() => {
    listScenarios()
      .then((scenarios) => {
        if (scenarios.length === 0) return;
        setConversations((prev) => {
          // Merge: keep any in-memory conversations (with messages), add DB scenarios not yet in memory
          const existingScenarioIds = new Set(prev.map((c) => c.scenarioId).filter(Boolean));
          const newConvs: Conversation[] = scenarios
            .filter((s) => !existingScenarioIds.has(s.scenario_id))
            .map((s) => ({
              id: s.scenario_id,
              title: s.name || s.nl_input?.slice(0, 60) || "Scenario",
              messages: [
                {
                  id: `loaded-${s.scenario_id}`,
                  role: "assistant" as const,
                  content: `**Scenario:** ${s.nl_input || "(no description)"}\n\n**Status:** ${s.status}\n\nClick **Review Parameters** to continue working with this scenario.`,
                  timestamp: new Date(s.created_at),
                },
              ],
              updatedAt: new Date(s.created_at),
              scenarioId: s.scenario_id,
            }));
          return newConvs.length > 0 ? [...prev, ...newConvs] : prev;
        });
      })
      .catch(() => {
        // If API is not reachable, silently continue with empty state
      });
  }, []);

  // Auto-expand follow-up questions when they appear
  useEffect(() => {
    if (pendingQuestions && pendingQuestions.length > 0) {
      setExpandedPanel("followUp");
    }
  }, [pendingQuestions]);

  const active = activeId ? conversations.find((c) => c.id === activeId) : null;
  const messages = active?.messages ?? [];

  const addAssistantMessage = useCallback(
    (convId: string, content: string, thinking?: ThinkingData) => {
      const msg: Message = { id: generateId(), role: "assistant", content, timestamp: new Date(), thinking };
      setConversations((prev) =>
        prev.map((c) => (c.id !== convId ? c : { ...c, messages: [...c.messages, msg], updatedAt: new Date() }))
      );
    },
    []
  );

  const closeAllPanels = useCallback(() => {
    setShowReview(false);
    setShowComparison(false);
    setShowAudit(false);
    setShowMonteCarlo(false);
    setShowTornado(false);
    setShowTemplates(false);
    setShowInsights(false);
    setPreloadedInsight(null);
    setShowPeriods(false);
    setPeriodData(null);
    setShowCharts(false);
    setShowSharing(false);
    setShowRoles(false);
    setShowDocuments(false);
    setShowDocManager(false);
    setPendingQuestions(null);
    setExpandedPanel(null);
  }, []);

  const handleNewChat = useCallback(() => {
    const id = generateId();
    setConversations((prev) => [{ id, title: "New scenario", messages: [], updatedAt: new Date() }, ...prev]);
    setActiveId(id);
    setSessionId(null);
    closeAllPanels();
  }, [closeAllPanels]);

  const handleSelect = useCallback((id: string) => {
    setActiveId(id);
    setSessionId(null);
    closeAllPanels();
  }, [closeAllPanels]);

  const handleSend = useCallback(
    async (text: string) => {
      let convId = activeId;
      if (!convId) {
        convId = generateId();
        setConversations((prev) => [{ id: convId!, title: firstLine(text), messages: [], updatedAt: new Date() }, ...prev]);
        setActiveId(convId);
      }

      const userMessage: Message = { id: generateId(), role: "user", content: text, timestamp: new Date() };
      setConversations((prev) =>
        prev.map((c) => {
          if (c.id !== convId) return c;
          return { ...c, messages: [...c.messages, userMessage], title: c.messages.length === 0 ? firstLine(text) : c.title, updatedAt: new Date() };
        })
      );

      setIsLoading(true);
      const cId = convId;

      // ── Conversational follow-up path ──
      if (sessionId && active?.scenarioId) {
        try {
          const result = await addFollowUp(sessionId, text);
          const parts: string[] = [];
          if (result.added_parameters.length > 0) {
            parts.push(
              "**Updated parameters (follow-up):**\n" +
                result.added_parameters
                  .map((p) => `- **${p.name}** \u2192 ${p.mapped_variable_id}: ${p.scenario_value}`)
                  .join("\n")
            );
            parts.push(`Total active parameters: ${result.cumulative_count}`);
            parts.push("Click **Review Parameters** to review all parameters, then **Approve & Run** to re-simulate.");
          }
          if (result.clarification_needed) parts.push(result.clarification_needed);
          if (parts.length === 0) parts.push("No new parameters extracted from follow-up.");
          addAssistantMessage(cId, parts.join("\n\n"));
          setShowReview(true);
          setExpandedPanel("review");
        } catch (e) {
          addAssistantMessage(cId, "Follow-up failed: " + (e as Error).message);
        }
        setIsLoading(false);
        return;
      }

      // ── New scenario path ──
      let assistantContent: string;
      let scenarioIdFromApi: string | undefined;
      let thinkingData: ThinkingData | undefined;
      try {
        const data = await parseScenario(text);
        scenarioIdFromApi = data.scenario_id ?? undefined;

        // Capture reflection/thinking data for visible display
        if (data.reflection) {
          thinkingData = {
            thinking: data.reflection.thinking,
            intent: data.reflection.intent,
            assumptions: data.reflection.assumptions || [],
            second_order_effects: data.reflection.second_order_effects || [],
            duration_ms: data.reflection.duration_ms,
          };
        }

        const parts: string[] = [];

        // Show notices (degraded features, config issues)
        if (data.notices && data.notices.length > 0) {
          for (const notice of data.notices) {
            const icon = notice.type === "warning" ? "\u26A0\uFE0F" : "\u2139\uFE0F";
            parts.push(`${icon} ${notice.message}`);
          }
        }

        // Show search context if Perplexity research was performed
        if (data.search_context) {
          const sc = data.search_context;
          parts.push(
            `**Research Context** _(real-time web search)_\n\n` +
            `${sc.summary.slice(0, 600)}${sc.summary.length > 600 ? "..." : ""}`
          );
          if (sc.data_points.length > 0) {
            parts.push(
              "**Key Data Points:**\n" +
              sc.data_points.slice(0, 6).map((d) => `- ${d}`).join("\n")
            );
          }
          if (sc.sources.length > 0) {
            parts.push(
              "_Sources: " + sc.sources.slice(0, 3).join(", ") + "_"
            );
          }
        }

        if (data.clarification_needed) parts.push(data.clarification_needed);
        if (data.parameters && data.parameters.length > 0) {
          parts.push(
            "**Parsed parameters:**\n" +
              data.parameters
                .map(
                  (p) =>
                    `- **${p.name}**: ${p.direction} ${p.magnitude} ${p.unit}` +
                    (Object.keys(p.scope || {}).length ? ` (${JSON.stringify(p.scope)})` : "") +
                    ` \u2014 confidence ${(p.confidence * 100).toFixed(0)}%`
                )
                .join("\n")
          );
          if (data.scenario_id) {
            parts.push("\nClick **Review Parameters** below to accept/reject parameters, then **Approve & Run** to simulate.");
            parts.push("You can also type follow-up adjustments like _\"also increase marketing 10%\"_ to refine.");
          }
        } else if (!data.clarification_needed && !data.follow_up_questions?.length) {
          parts.push('No parameters extracted. Try rephrasing, e.g. "What if we delay the APAC launch by one quarter and raw materials increase 8%?"');
        }

        // If the parser generated follow-up questions, show them
        if (data.follow_up_questions && data.follow_up_questions.length > 0) {
          setPendingQuestions(data.follow_up_questions);
          if (data.parameters.length > 0) {
            parts.push("\nI've extracted initial parameters but need a few more details to be more precise. Please answer the questions below.");
          } else {
            parts.push("\nI need a bit more information to model this scenario. Please answer the questions below.");
          }
        }

        assistantContent = parts.join("\n\n");

        // Start a conversational session for follow-ups
        if (scenarioIdFromApi) {
          try {
            const sess = await createSession(scenarioIdFromApi);
            setSessionId(sess.session_id);
          } catch {
            // session creation is optional
          }
        }
      } catch (e) {
        const errorMsg = (e as Error).message || "";
        if (errorMsg.includes("No model found") || errorMsg.includes("needs_onboarding") || errorMsg.includes("upload documents")) {
          assistantContent =
            "**Getting Started**\n\n" +
            "Before creating scenarios, you need to set up your company context:\n\n" +
            "1. Click **Document Manager** below\n" +
            "2. Upload your financial documents (P&L, income statements, reports)\n" +
            "3. Click **Build Context** to have AI extract your company profile and create a financial model\n" +
            "4. Review and confirm the generated model\n" +
            "5. Then describe your scenarios here!\n\n" +
            "_The system will learn from your documents and create a custom model for your business._";
          setShowDocManager(true);
          setExpandedPanel("docManager");
        } else {
          assistantContent =
            "Something went wrong. Please make sure the backend is running and try again.";
        }
      }

      const assistantMessage: Message = { id: generateId(), role: "assistant", content: assistantContent, timestamp: new Date(), thinking: thinkingData };
      setConversations((prev) =>
        prev.map((c) => {
          if (c.id !== cId) return c;
          return { ...c, messages: [...c.messages, assistantMessage], updatedAt: new Date(), scenarioId: scenarioIdFromApi ?? c.scenarioId };
        })
      );
      setIsLoading(false);
      if (scenarioIdFromApi) {
        setShowReview(true);
        setExpandedPanel("review");
      }
    },
    [activeId, active?.scenarioId, sessionId, addAssistantMessage]
  );

  const handleApproved = useCallback(async () => {
    const scenarioId = active?.scenarioId;
    const convId = activeId;
    if (!scenarioId || !convId) return;
    setShowReview(false);
    setExpandedPanel(null);
    setIsLoading(true);
    addAssistantMessage(convId, "Parameters approved. Running simulation...");
    try {
      const result = await runScenario(scenarioId);

      // Aggregate P&L
      const plText =
        `**P&L in ${getCurrencyLabel()} (scenario total${result.period_count ? ` \u2014 ${result.period_count} ${result.granularity || "periods"}` : ""}):**\n` +
        Object.entries(result.pl || {})
          .map(([k, v]) => `- **${k}**: ${getCurrencySymbol()}${v.toLocaleString()}`)
          .join("\n");
      addAssistantMessage(convId, plText);

      // Surface absurdity warnings from simulation validation
      if (result.absurdity_warnings && result.absurdity_warnings.length > 0) {
        const warningText =
          "**Validation Warnings:**\n" +
          result.absurdity_warnings.map((w: string) => `- ${w}`).join("\n") +
          "\n\n_The model detected potentially disproportionate results. Please review the parameters above._";
        addAssistantMessage(convId, warningText);
      }

      // Store period data for interactive view
      if (result.periods && result.periods.length > 1) {
        setPeriodData({ periods: result.periods, granularity: result.granularity || "quarterly", pl: result.pl });
        setShowPeriods(true);
        addAssistantMessage(convId, `Multi-period breakdown available (${result.periods.length} ${result.granularity || "quarterly"} periods). See the panel below.`);
      }

      // Fetch base case for charts
      try {
        const base = await getBaseCase();
        setChartData({
          pl: result.pl,
          basePl: base.pl,
          periods: result.periods,
          granularity: result.granularity,
        });
      } catch {
        setChartData({ pl: result.pl, periods: result.periods, granularity: result.granularity });
      }

      try {
        const narrative = await generateNarrative(scenarioId);
        addAssistantMessage(convId, "**Executive Summary:**\n\n" + narrative);
      } catch {
        // narrative is optional
      }

      // Auto-trigger the Business Analyst Agent + QA reflection loop
      addAssistantMessage(convId, "Running business analysis agent with quality assurance loop...");
      try {
        const insight = await generateBusinessAnalysis(scenarioId);
        setPreloadedInsight(insight);
        setShowInsights(true);
        setExpandedPanel("insights");

        // Show QA loop result summary in chat
        const qaStatus = insight.qa_report
          ? insight.qa_report.passed
            ? `Quality Assurance: **${insight.qa_report.overall_score}/10** (passed after ${insight.qa_report.iterations} ${insight.qa_report.iterations === 1 ? "review" : "reviews"})`
            : `Quality Assurance: **${insight.qa_report.overall_score}/10** (did not pass — see warnings in the panel)`
          : "";

        addAssistantMessage(
          convId,
          `**So What?**\n\n${insight.headline}\n\n` +
            (qaStatus ? qaStatus + "\n\n" : "") +
            `**Top actions:**\n${insight.recommendations
              .slice(0, 3)
              .map((r, i) => `${i + 1}. **${r.action}** _(${r.priority})_${r.owner ? ` \u2192 ${r.owner}` : ""}`)
              .join("\n")}\n\n` +
            "See the **Business Insights** panel for full analysis, agent reflection log, and QA report."
        );
      } catch {
        addAssistantMessage(convId, "Business analysis could not be generated. Click **So What?** in the toolbar to retry.");
      }
    } catch (e) {
      addAssistantMessage(convId, "Simulation failed: " + (e as Error).message);
    }
    setIsLoading(false);
  }, [active?.scenarioId, activeId, addAssistantMessage]);

  const handleFollowUpAnswers = useCallback(
    async (answers: { question_id: string; answer: string }[]) => {
      const scenarioId = active?.scenarioId;
      const convId = activeId;
      if (!scenarioId || !convId) return;

      setPendingQuestions(null);
      setIsLoading(true);

      // Show user's answers in chat
      const answerSummary = answers.map((a) => `- **${a.question_id}**: ${a.answer}`).join("\n");
      addAssistantMessage(convId, `**Your answers:**\n${answerSummary}\n\nRefining scenario parameters...`);

      try {
        const data = await refineScenario(scenarioId, answers);
        const parts: string[] = [];

        // Capture reflection data from refinement
        let refineThinking: ThinkingData | undefined;
        if (data.reflection) {
          refineThinking = {
            thinking: data.reflection.thinking,
            intent: data.reflection.intent,
            assumptions: data.reflection.assumptions || [],
            second_order_effects: data.reflection.second_order_effects || [],
            duration_ms: data.reflection.duration_ms,
          };
        }

        // Show notices
        if (data.notices && data.notices.length > 0) {
          for (const notice of data.notices) {
            const icon = notice.type === "warning" ? "\u26A0\uFE0F" : "\u2139\uFE0F";
            parts.push(`${icon} ${notice.message}`);
          }
        }

        // Show search context if returned
        if (data.search_context) {
          const sc = data.search_context;
          parts.push(
            `**Research Context** _(real-time web search)_\n\n` +
            `${sc.summary.slice(0, 600)}${sc.summary.length > 600 ? "..." : ""}`
          );
          if (sc.data_points.length > 0) {
            parts.push(
              "**Key Data Points:**\n" + sc.data_points.slice(0, 6).map((d) => `- ${d}`).join("\n")
            );
          }
        }

        if (data.parameters && data.parameters.length > 0) {
          parts.push(
            "**Refined parameters:**\n" +
              data.parameters
                .map(
                  (p) =>
                    `- **${p.name}**: ${p.direction} ${p.magnitude} ${p.unit}` +
                    (Object.keys(p.scope || {}).length ? ` (${JSON.stringify(p.scope)})` : "") +
                    ` \u2014 confidence ${(p.confidence * 100).toFixed(0)}%`
                )
                .join("\n")
          );
          parts.push("\nClick **Review Parameters** to accept/reject, then **Approve & Run** to simulate.");
        }

        // If there are MORE follow-up questions, show them
        if (data.follow_up_questions && data.follow_up_questions.length > 0) {
          setPendingQuestions(data.follow_up_questions);
          parts.push("\nI have a few more questions to further refine the scenario.");
        }

        if (data.clarification_needed) parts.push(data.clarification_needed);

        addAssistantMessage(convId, parts.join("\n\n") || "Parameters refined. Review them below.", refineThinking);
        // Force ParameterReview to re-mount + re-fetch updated parameters
        setParamRefreshKey((k) => k + 1);
        setShowReview(true);
        setExpandedPanel("review");
      } catch (e) {
        addAssistantMessage(convId, "Refinement failed: " + (e as Error).message);
      }
      setIsLoading(false);
    },
    [active?.scenarioId, activeId, addAssistantMessage]
  );

  const handleTemplateCloned = useCallback((newScenarioId: string) => {
    const convId = generateId();
    const msg: Message = {
      id: generateId(),
      role: "assistant",
      content: `Template cloned as new scenario \`${newScenarioId.slice(0, 8)}...\`. Click **Review Parameters** to review and run.`,
      timestamp: new Date(),
    };
    setConversations((prev) => [
      { id: convId, title: "Template clone", messages: [msg], updatedAt: new Date(), scenarioId: newScenarioId },
      ...prev,
    ]);
    setActiveId(convId);
    setShowTemplates(false);
    setShowReview(true);
    setExpandedPanel("review");

    // Start session for follow-ups on cloned scenario
    createSession(newScenarioId)
      .then((sess) => setSessionId(sess.session_id))
      .catch(() => {});
  }, []);

  // ── Panel card definitions ──
  // Each active panel appears as a compact card in the strip below the chat.
  // Clicking a card expands it in a modal overlay.
  const CARD_COLORS: Record<string, string> = {
    review: "bg-accent", comparison: "bg-[var(--info)]", monteCarlo: "bg-accent",
    tornado: "bg-[var(--warning)]", periods: "bg-accent", charts: "bg-accent",
    sharing: "bg-[var(--info)]", audit: "bg-[var(--text-muted)]",
    templates: "bg-[var(--info)]", roles: "bg-[var(--warning)]",
    insights: "bg-[var(--success)]", followUp: "bg-accent",
    documents: "bg-[var(--info)]",
    docManager: "bg-accent",
  };

  const panelCards = useMemo(() => {
    const cards: { id: string; title: string; close: () => void }[] = [];
    if (showReview && active?.scenarioId) cards.push({ id: "review", title: "Parameters", close: () => setShowReview(false) });
    if (showComparison && active?.scenarioId) cards.push({ id: "comparison", title: "Comparison", close: () => setShowComparison(false) });
    if (showMonteCarlo && active?.scenarioId) cards.push({ id: "monteCarlo", title: "Monte Carlo", close: () => setShowMonteCarlo(false) });
    if (showTornado && active?.scenarioId) cards.push({ id: "tornado", title: "Sensitivity", close: () => setShowTornado(false) });
    if (showPeriods && periodData) cards.push({ id: "periods", title: "Periods", close: () => setShowPeriods(false) });
    if (showCharts && chartData) cards.push({ id: "charts", title: "Charts", close: () => setShowCharts(false) });
    if (showSharing && active?.scenarioId) cards.push({ id: "sharing", title: "Sharing", close: () => setShowSharing(false) });
    if (showAudit) cards.push({ id: "audit", title: "Audit Trail", close: () => setShowAudit(false) });
    if (showTemplates) cards.push({ id: "templates", title: "Templates", close: () => setShowTemplates(false) });
    if (showRoles) cards.push({ id: "roles", title: "Roles", close: () => setShowRoles(false) });
    if (showInsights && active?.scenarioId) cards.push({ id: "insights", title: "Business Insights", close: () => { setShowInsights(false); setPreloadedInsight(null); } });
    if (pendingQuestions && pendingQuestions.length > 0 && active?.scenarioId) cards.push({ id: "followUp", title: "Refine Scenario", close: () => setPendingQuestions(null) });
    if (showDocuments) cards.push({ id: "documents", title: "Documents", close: () => setShowDocuments(false) });
    if (showDocManager) cards.push({ id: "docManager", title: "Document Manager", close: () => setShowDocManager(false) });
    return cards;
  }, [showReview, showComparison, showMonteCarlo, showTornado, showPeriods, showCharts, showSharing, showAudit, showTemplates, showRoles, showInsights, pendingQuestions, showDocuments, showDocManager, active?.scenarioId, periodData, chartData]);

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

  // Close panel entirely (card + modal)
  const closePanel = (id: string, closeFn: () => void) => {
    closeFn();
    if (expandedPanel === id) setExpandedPanel(null);
  };

  // Render the content of the currently expanded panel inside the modal
  const collapseModal = () => setExpandedPanel(null);
  const renderExpandedPanel = () => {
    const sid = active?.scenarioId;
    switch (expandedPanel) {
      case "review":
        return sid ? <ParameterReview key={`pr-${sid}-${paramRefreshKey}`} scenarioId={sid} onApproved={handleApproved} onClose={() => closePanel("review", () => setShowReview(false))} onMinimize={collapseModal} /> : null;
      case "comparison":
        return sid ? <ComparisonView currentScenarioId={sid} onClose={() => closePanel("comparison", () => setShowComparison(false))} onMinimize={collapseModal} /> : null;
      case "monteCarlo":
        return sid ? <MonteCarloView scenarioId={sid} onClose={() => closePanel("monteCarlo", () => setShowMonteCarlo(false))} onMinimize={collapseModal} /> : null;
      case "tornado":
        return sid ? <TornadoChart scenarioId={sid} onClose={() => closePanel("tornado", () => setShowTornado(false))} onMinimize={collapseModal} /> : null;
      case "periods":
        return periodData ? <PeriodBreakdownView periods={periodData.periods} granularity={periodData.granularity} totalPl={periodData.pl} onClose={() => closePanel("periods", () => setShowPeriods(false))} onMinimize={collapseModal} /> : null;
      case "charts":
        return chartData ? <ScenarioCharts pl={chartData.pl} basePl={chartData.basePl} periods={chartData.periods} granularity={chartData.granularity} onClose={() => closePanel("charts", () => setShowCharts(false))} onMinimize={collapseModal} /> : null;
      case "sharing":
        return sid ? <SharingPanel scenarioId={sid} onClose={() => closePanel("sharing", () => setShowSharing(false))} onMinimize={collapseModal} /> : null;
      case "audit":
        return <AuditTrailViewer scenarioId={sid ?? undefined} onClose={() => closePanel("audit", () => setShowAudit(false))} onMinimize={collapseModal} />;
      case "templates":
        return <TemplateGallery scenarioId={sid ?? undefined} onCloned={handleTemplateCloned} onClose={() => closePanel("templates", () => setShowTemplates(false))} onMinimize={collapseModal} />;
      case "roles":
        return <RoleManagement onClose={() => closePanel("roles", () => setShowRoles(false))} onMinimize={collapseModal} />;
      case "insights":
        return sid ? <BusinessInsights scenarioId={sid} preloaded={preloadedInsight} onClose={() => closePanel("insights", () => { setShowInsights(false); setPreloadedInsight(null); })} onMinimize={collapseModal} /> : null;
      case "followUp":
        return pendingQuestions && pendingQuestions.length > 0 ? <FollowUpQuestions questions={pendingQuestions} onSubmit={handleFollowUpAnswers} isLoading={isLoading} /> : null;
      case "documents":
        return <DocumentPanel onClose={() => closePanel("documents", () => setShowDocuments(false))} onMinimize={collapseModal} />;
      case "docManager":
        return <DocumentManager onClose={() => closePanel("docManager", () => setShowDocManager(false))} onMinimize={collapseModal} onContextBuilt={() => { getOnboardingStatus().then((s) => { setOnboardingStatus(s); if (s.currency) setCurrency(s.currency, s.currency_unit); }).catch(() => {}); }} />;
      default:
        return null;
    }
  };

  // Action bar button style
  const actionBtn = (isActive: boolean) =>
    `rounded-xl border px-3 py-1.5 text-xs font-medium transition-all ${
      isActive
        ? "bg-accent/10 border-accent/30 text-accent shadow-sm"
        : "border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--panel-bg)] hover:border-[var(--panel-border)] hover:shadow-card"
    } disabled:opacity-40`;

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <Sidebar conversations={conversations} activeId={activeId} onSelect={handleSelect} onNewChat={handleNewChat} />
      <div className="flex flex-col flex-1 min-w-0 relative">
        {/* Top bar with role switcher */}
        <div className="flex items-center justify-between px-4 py-2 border-b border-[var(--border)] bg-[var(--card-bg)]/80 backdrop-blur-sm shrink-0">
          <h1 className="text-sm font-semibold text-[var(--text-primary)]">Scenario Modeling</h1>
          <RoleSwitcher />
        </div>

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
        <MessageList messages={messages} isLoading={isLoading} />

        {/* ── Analysis card strip: compact cards for each active panel ── */}
        {panelCards.length > 0 && (
          <div className="px-3 py-2 border-t border-[var(--border)] bg-[var(--panel-bg)]/60 flex gap-2 overflow-x-auto shrink-0">
            {panelCards.map((card) => (
              <button
                key={card.id}
                type="button"
                onClick={() => setExpandedPanel(expandedPanel === card.id ? null : card.id)}
                className={`flex items-center gap-2 pl-2.5 pr-1.5 py-1.5 rounded-lg border text-xs font-medium transition-all group shrink-0 ${
                  expandedPanel === card.id
                    ? "bg-accent/10 border-accent/30 text-accent shadow-sm ring-1 ring-accent/20"
                    : "border-[var(--border)] bg-[var(--card-bg)] text-[var(--text-primary)] hover:border-[var(--panel-border)] hover:shadow-card"
                }`}
              >
                <span className={`w-2 h-2 rounded-full shrink-0 ${CARD_COLORS[card.id] || "bg-accent"}`} />
                <span className="whitespace-nowrap">{card.title}</span>
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(e) => { e.stopPropagation(); closePanel(card.id, card.close); }}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); closePanel(card.id, card.close); } }}
                  className="ml-1 w-4 h-4 rounded flex items-center justify-center opacity-0 group-hover:opacity-100 text-[var(--text-faint)] hover:text-[var(--danger)] hover:bg-[var(--danger-bg)] transition-all"
                  title="Remove"
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </span>
              </button>
            ))}
          </div>
        )}

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
              {showDocManager ? "Hide Manager" : "Manager"}
            </button>
            <button
              type="button"
              onClick={() => {
                if (showInsights) {
                  setShowInsights(false); setPreloadedInsight(null);
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
            sessionId
              ? "Type a follow-up adjustment (e.g. \"also increase marketing 10%\")\u2026"
              : onboardingStatus && !onboardingStatus.ready
              ? "Upload documents and build context first, then describe scenarios here\u2026"
              : "Describe your scenario in plain English\u2026"
          }
        />

        {/* ── Modal overlay for expanded panel ── */}
        {expandedPanel && (
          <AnalysisModal onCollapse={() => setExpandedPanel(null)}>
            {renderExpandedPanel()}
          </AnalysisModal>
        )}
      </div>
    </div>
  );
}
