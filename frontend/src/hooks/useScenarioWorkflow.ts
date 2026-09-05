"use client";

import { useCallback, useEffect } from "react";
import { toast } from "sonner";
import {
  parseScenario,
  refineScenario,
  runScenario,
  generateNarrativeStream,
  generateBusinessAnalysis,
  createSession,
  addFollowUp,
  getBaseCase,
  initUserContext,
  listScenarios,
  getOnboardingStatus,
  queryAllDocuments,
  type FollowUpAnswer,
} from "@/lib/api";
import { probePlanningConnectors } from "@/lib/features";
import { buildRunReportSections } from "@/lib/runReport";
import { setCurrency, getCurrencyLabel, fmtMetric, metricLabel } from "@/lib/metrics";
import type { Message, ThinkingData, CausalChainStep, AgentTraceStep } from "@/types/chat";
import { useChatStore } from "@/stores/chatStore";
import { useUiStore } from "@/stores/uiStore";
import { useSessionStore } from "@/stores/sessionStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";

/** Real UUIDs so conversation ids created locally can be persisted to the
 *  backend (chat_conversations.id is UUID) without any remapping later. */
function generateId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Fallback (older environments / non-secure contexts) — not cryptographically
  // strong but structurally a valid v4 UUID.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function firstLine(text: string, maxLen = 50) {
  const line = text.split(/\n/)[0]?.trim() || "";
  return line.length > maxLen ? line.slice(0, maxLen) + "\u2026" : line;
}

export function useScenarioWorkflow() {
  const conversations = useChatStore((s) => s.conversations);
  const activeId = useChatStore((s) => s.activeId);
  const setConversations = useChatStore((s) => s.setConversations);
  const setActiveId = useChatStore((s) => s.setActiveId);
  const addMessage = useChatStore((s) => s.addMessage);
  const updateConversation = useChatStore((s) => s.updateConversation);
  const selectConversation = useChatStore((s) => s.selectConversation);
  const renameConversation = useChatStore((s) => s.renameConversation);
  const deleteConversation = useChatStore((s) => s.deleteConversation);
  const deleteConversations = useChatStore((s) => s.deleteConversations);
  const hydrateFromBackend = useChatStore((s) => s.hydrateFromBackend);
  const assistantMode = useChatStore((s) => s.assistantMode);
  const documentConversationId = useChatStore((s) => s.documentConversationId);
  const setDocumentConversationId = useChatStore((s) => s.setDocumentConversationId);

  const {
    onboardingStatus, isLoading,
    openPanel, showPanel, closePanel, setExpandedPanel, closeAllPanels,
    setPreloadedInsight, setPeriodData,
    setChartData, setPendingQuestions, setOnboardingStatus, bumpRefineKey,
    setIsLoading, setDimensionalPov, setDimensionalMetric,
    openDocManagerForValidation,
  } = useUiStore();

  const sessionId = useSessionStore((s) => s.sessionId);
  const setSession = useSessionStore((s) => s.setSession);
  const clearSession = useSessionStore((s) => s.clearSession);

  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const workspacesLoaded = useWorkspaceStore((s) => s.loaded);
  const loadWorkspaces = useWorkspaceStore((s) => s.loadWorkspaces);

  // Resolve the workspace list once so the persisted active id is validated
  // before workspace-scoped fetches run.
  useEffect(() => {
    if (!workspacesLoaded) loadWorkspaces().catch(() => {});
  }, [workspacesLoaded, loadWorkspaces]);

  // Initialize user context + check onboarding; re-runs on workspace switch
  // (onboarding status, model, and currency are all workspace-scoped).
  useEffect(() => {
    initUserContext().catch(() => {});
    probePlanningConnectors().catch(() => {});
    getOnboardingStatus().then((s) => {
      setOnboardingStatus(s);
      if (s.currency) setCurrency(s.currency, s.currency_unit ?? undefined);
    }).catch(() => {});
  }, [setOnboardingStatus, activeWorkspaceId]);

  // Restore persisted chat history for this workspace, then backfill any
  // scenarios that predate chat persistence (or never got a chat row) as
  // read-only synthetic conversations. Sequenced (not parallel effects) so
  // the backfill never races the hydrate and gets clobbered by it.
  // Re-runs on workspace switch — workspaceStore.resetWorkspaceState()
  // clears conversations synchronously on switch, this refills them.
  useEffect(() => {
    if (!workspacesLoaded) return;
    let cancelled = false;
    hydrateFromBackend()
      .catch(() => {})
      .then(() => listScenarios())
      .then((scenarios) => {
        if (cancelled || scenarios.length === 0) return;
        setConversations((prev) => {
          // Merge: keep hydrated/in-memory conversations, add DB scenarios not yet represented
          const existingScenarioIds = new Set(prev.map((c) => c.scenarioId).filter(Boolean));
          const newConvs = scenarios
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
    return () => {
      cancelled = true;
    };
  }, [setConversations, hydrateFromBackend, workspacesLoaded, activeWorkspaceId]);

  const active = activeId ? conversations.find((c) => c.id === activeId) : null;
  const messages = active?.messages ?? [];

  const addAssistantMessage = useCallback(
    (convId: string, content: string, thinking?: ThinkingData) => {
      const msg: Message = { id: generateId(), role: "assistant", content, timestamp: new Date(), thinking };
      addMessage(convId, msg);
    },
    [addMessage]
  );

  const handleNewChat = useCallback(() => {
    const id = generateId();
    setConversations((prev) => [{ id, title: "New scenario", messages: [], updatedAt: new Date() }, ...prev]);
    setActiveId(id);
    clearSession();
    closeAllPanels();
  }, [setConversations, setActiveId, clearSession, closeAllPanels]);

  const handleSelect = useCallback((id: string) => {
    selectConversation(id);
    closeAllPanels();
  }, [selectConversation, closeAllPanels]);

  const handleRename = useCallback(
    (id: string, title: string) => {
      renameConversation(id, title);
    },
    [renameConversation]
  );

  const handleDelete = useCallback(
    async (id: string) => {
      const conv = useChatStore.getState().conversations.find((c) => c.id === id);
      const scenarioId = conv?.scenarioId ?? null;
      try {
        if (scenarioId) {
          const { deleteScenario } = await import("@/lib/api");
          await deleteScenario(scenarioId);
        }
        const wasActive = activeId === id;
        deleteConversation(id);
        if (wasActive) closeAllPanels();
      } catch (e) {
        toast.error("Could not delete scenario", {
          description: (e as Error).message,
        });
      }
    },
    [activeId, deleteConversation, closeAllPanels]
  );

  const handleDeleteMany = useCallback(
    async (ids: string[]) => {
      const convs = useChatStore.getState().conversations;
      const idToScenario = new Map<string, string>();
      for (const id of ids) {
        const conv = convs.find((c) => c.id === id);
        if (conv?.scenarioId) idToScenario.set(id, conv.scenarioId);
      }
      const remoteIds = Array.from(idToScenario.values());
      try {
        let deletedRemote = new Set<string>();
        if (remoteIds.length > 0) {
          const { deleteScenarios } = await import("@/lib/api");
          const result = await deleteScenarios(remoteIds);
          deletedRemote = new Set(result.deleted);
          if (result.failed.length > 0 && result.deleted.length === 0) {
            throw new Error(result.failed[0]?.error || "Failed to delete scenarios");
          }
          if (result.failed.length > 0) {
            toast.warning(
              `Deleted ${result.deleted.length}; ${result.failed.length} could not be deleted.`,
            );
          }
        }
        const toRemove = ids.filter((id) => {
          const sid = idToScenario.get(id);
          return !sid || deletedRemote.has(sid);
        });
        const wasActive = activeId != null && toRemove.includes(activeId);
        deleteConversations(toRemove);
        if (wasActive) closeAllPanels();
      } catch (e) {
        toast.error("Could not delete scenarios", {
          description: (e as Error).message,
        });
      }
    },
    [activeId, deleteConversations, closeAllPanels]
  );

  const persistSession = useCallback(
    (convId: string, newSessionId: string, scenarioId: string) => {
      setSession(newSessionId, scenarioId);
      updateConversation(convId, { sessionId: newSessionId, scenarioId });
    },
    [setSession, updateConversation]
  );

  const handleSend = useCallback(
    async (text: string) => {
      let convId = activeId;
      if (!convId) {
        convId = generateId();
        setConversations((prev) => [{ id: convId!, title: firstLine(text), messages: [], updatedAt: new Date() }, ...prev]);
        setActiveId(convId);
      }

      const userMessage: Message = { id: generateId(), role: "user", content: text, timestamp: new Date() };
      updateConversation(convId, (c) => ({
        ...c,
        messages: [...c.messages, userMessage],
        title: c.messages.length === 0 ? firstLine(text) : c.title,
        updatedAt: new Date(),
      }));

      setIsLoading(true);
      const cId = convId;

      // ── Document Q&A path (auth'd RAG; does not create/approve scenarios) ──
      if (assistantMode === "documents") {
        try {
          const result = await queryAllDocuments(text, documentConversationId ?? undefined);
          if (result.conversation_id) setDocumentConversationId(result.conversation_id);
          const sources =
            result.sources?.length > 0
              ? "\n\n_Sources: " +
                result.sources
                  .slice(0, 4)
                  .map((s) => s.document_name)
                  .filter(Boolean)
                  .join(", ") +
                "_"
              : "";
          addAssistantMessage(cId, result.answer + sources);
        } catch (e) {
          addAssistantMessage(cId, "Document Q&A failed: " + (e as Error).message);
        }
        setIsLoading(false);
        return;
      }

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
          openPanel("review");
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
      let causalChain: CausalChainStep[] | undefined;
      let agentTrace: AgentTraceStep[] | undefined;
      let agentConfidence: number | undefined;
      let agentCitations: Message["agentCitations"];
      let previewPl: Record<string, number> | undefined;
      let previewReconciliation: Message["previewReconciliation"];
      let constraintViolations: Message["constraintViolations"];
      let hasFollowUps = false;
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

        if (data.causal_chain?.length) causalChain = data.causal_chain;
        if (data.agent_trace?.length) agentTrace = data.agent_trace;
        if (data.agent_confidence != null) agentConfidence = data.agent_confidence;
        if (data.citations?.length) agentCitations = data.citations;
        if (data.preview_pl && Object.keys(data.preview_pl).length > 0) previewPl = data.preview_pl;
        if (data.preview_reconciliation) {
          previewReconciliation = {
            reconciled: !!data.preview_reconciliation.reconciled,
            max_abs_diff: Number(data.preview_reconciliation.max_abs_diff) || 0,
            message: data.preview_reconciliation.message,
          };
        }
        if (data.constraint_violations?.length) constraintViolations = data.constraint_violations;

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
          hasFollowUps = true;
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
            persistSession(cId, sess.session_id, scenarioIdFromApi);
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
          openPanel("docManager");
        } else {
          assistantContent =
            "Something went wrong. Please make sure the backend is running and try again.";
        }
      }

      const assistantMessage: Message = {
        id: generateId(),
        role: "assistant",
        content: assistantContent,
        timestamp: new Date(),
        thinking: thinkingData,
        causalChain,
        agentTrace,
        agentConfidence,
        agentCitations,
        previewPl,
        previewReconciliation,
        constraintViolations,
      };
      updateConversation(cId, (c) => ({
        ...c,
        messages: [...c.messages, assistantMessage],
        updatedAt: new Date(),
        scenarioId: scenarioIdFromApi ?? c.scenarioId,
      }));
      setIsLoading(false);
      if (scenarioIdFromApi) {
        showPanel("review");
        // Prefer follow-up panel over Review when probing questions are pending
        setExpandedPanel(hasFollowUps ? "followUp" : "review");
      }
    },
    [
      activeId, active?.scenarioId, sessionId, addAssistantMessage,
      setConversations, setActiveId, updateConversation, setIsLoading,
      openPanel, showPanel, setExpandedPanel, setPendingQuestions,
      persistSession, assistantMode, documentConversationId, setDocumentConversationId,
    ]
  );

  const handleApproved = useCallback(async () => {
    const scenarioId = active?.scenarioId;
    const convId = activeId;
    if (!scenarioId || !convId) return;
    closePanel("review");
    setIsLoading(true);
    setDimensionalPov({});
    setDimensionalMetric(null);
    addAssistantMessage(convId, "Parameters approved. Running simulation...");
    try {
      const result = await runScenario(scenarioId);

      // Aggregate P&L (currency, percent, etc. — format by metric id)
      const plEntries = Object.entries(result.pl || {});
      const plText =
        `**P&L in ${getCurrencyLabel()} (scenario total${result.period_count ? ` \u2014 ${result.period_count} ${result.granularity || "periods"}` : ""}):**\n` +
        plEntries
          .map(([k, v]) => `- **${metricLabel(k)}**: ${fmtMetric(k, v)}`)
          .join("\n");
      addAssistantMessage(convId, plText);

      // Every finding the run produced, in one place — see lib/runReport.ts.
      for (const section of buildRunReportSections(result)) {
        addAssistantMessage(convId, section.text);
      }

      // Store period data for interactive view
      if (result.periods && result.periods.length > 1) {
        setPeriodData({ periods: result.periods, granularity: result.granularity || "quarterly", pl: result.pl });
        showPanel("periods");
        addAssistantMessage(convId, `Multi-period breakdown available (${result.periods.length} ${result.granularity || "quarterly"} periods). See the panel below.`);
      }

      // Fetch base case for charts
      try {
        const base = await getBaseCase();
        setChartData({
          scenarioId,
          pl: result.pl,
          basePl: base.pl,
          periods: result.periods,
          granularity: result.granularity,
          dimensional: result.dimensional,
        });
      } catch {
        setChartData({
          scenarioId,
          pl: result.pl,
          periods: result.periods,
          granularity: result.granularity,
          dimensional: result.dimensional,
        });
      }

      try {
        addAssistantMessage(convId, "_Writing executive summary…_");
        const narrative = await generateNarrativeStream(scenarioId);
        addAssistantMessage(convId, "**Executive Summary:**\n\n" + narrative);
      } catch {
        // narrative is optional
      }

      // Auto-trigger the Business Analyst Agent + QA reflection loop
      addAssistantMessage(convId, "Running business analysis agent with quality assurance loop...");
      try {
        const insight = await generateBusinessAnalysis(scenarioId);
        setPreloadedInsight(insight);
        openPanel("insights");

        // Show QA loop result summary in chat
        const qaStatus = insight.qa_report
          ? insight.qa_report.status === "not_assessed"
            ? "Quality Assurance: **not assessed** (LLM unavailable — see Business Insights panel)"
            : insight.qa_report.passed
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
      const errorMsg = (e as Error).message || "";
      if (/not validated|analyst validation/i.test(errorMsg)) {
        addAssistantMessage(
          convId,
          "**Simulation blocked — spreadsheet model is not validated yet.**\n\n" +
            "1. Open **Document Manager** (opened for you)\n" +
            "2. Click **Mark Model Validated** in the amber banner\n" +
            "3. If validation succeeds, return here and click **Review Parameters** → approve again\n\n" +
            `_Details: ${errorMsg}_`,
        );
        openDocManagerForValidation();
      } else {
        addAssistantMessage(convId, "Simulation failed: " + errorMsg);
      }
    }
    setIsLoading(false);
  }, [
    active?.scenarioId, activeId, addAssistantMessage,
    closePanel, showPanel, openPanel, setIsLoading, setPeriodData,
    setChartData, setPreloadedInsight, setDimensionalPov, setDimensionalMetric,
    openDocManagerForValidation,
  ]);

  const handleFollowUpAnswers = useCallback(
    async (answers: FollowUpAnswer[]) => {
      const scenarioId = active?.scenarioId;
      const convId = activeId;
      if (!scenarioId || !convId) return;

      setPendingQuestions(null);
      setIsLoading(true);

      // Show user's answers in chat with acceptance/override provenance
      const answerSummary = answers
        .map((a) => {
          if (a.answer_kind === "accepted_recommendation") {
            return `- **${a.question_id}**: ${a.answer} _(accepted recommendation)_`;
          }
          if (a.answer_kind === "overridden") {
            const prev = a.recommended_value ? ` _(overrode “${a.recommended_value}”)_` : " _(overrode recommendation)_";
            return `- **${a.question_id}**: ${a.answer}${prev}`;
          }
          if (a.answer_kind === "comment") {
            return `- **${a.question_id}** _(comment)_: ${a.answer}`;
          }
          if (a.answer_kind === "custom") {
            return `- **${a.question_id}**: ${a.answer} _(custom)_`;
          }
          return `- **${a.question_id}**: ${a.answer}`;
        })
        .join("\n");
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
        bumpRefineKey();
        showPanel("review");
        setExpandedPanel(
          data.follow_up_questions && data.follow_up_questions.length > 0 ? "followUp" : "review",
        );
      } catch (e) {
        addAssistantMessage(convId, "Refinement failed: " + (e as Error).message);
      }
      setIsLoading(false);
    },
    [
      active?.scenarioId, activeId, addAssistantMessage,
      setPendingQuestions, setIsLoading, bumpRefineKey, showPanel, setExpandedPanel,
    ]
  );

  const handleTemplateCloned = useCallback((newScenarioId: string) => {
    const convId = generateId();
    const msg: Message = {
      id: generateId(),
      role: "assistant",
      content: `Template cloned as new scenario \`${newScenarioId.slice(0, 8)}...\`. Click **Review Parameters** to review and run.`,
      timestamp: new Date(),
    };
    // Create empty first (with scenarioId set) so addMessage's write-through
    // persists both the conversation row and this message.
    setConversations((prev) => [
      { id: convId, title: "Template clone", messages: [], updatedAt: new Date(), scenarioId: newScenarioId },
      ...prev,
    ]);
    setActiveId(convId);
    addMessage(convId, msg);
    closePanel("templates");
    openPanel("review");

    // Start session for follow-ups on cloned scenario
    createSession(newScenarioId)
      .then((sess) => {
        persistSession(convId, sess.session_id, newScenarioId);
      })
      .catch(() => {});
  }, [setConversations, setActiveId, addMessage, closePanel, openPanel, persistSession]);

  return {
    conversations,
    activeId,
    active,
    messages,
    sessionId,
    isLoading,
    onboardingStatus,
    assistantMode,
    handleNewChat,
    handleSelect,
    handleRename,
    handleDelete,
    handleDeleteMany,
    handleSend,
    handleApproved,
    handleFollowUpAnswers,
    handleTemplateCloned,
  };
}
