"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { PanelHeader } from "./PanelHeader";
import { MarkdownContent } from "./MarkdownContent";
import {
  generateBusinessAnalysis,
  getBusinessAnalysis,
  type BusinessInsight,
  type BusinessImplication,
  type BusinessRisk,
  type BusinessRecommendation,
  type QAReport,
  type ReflectionStep,
} from "@/lib/api";
import { strings } from "@/lib/strings";
import { useUiStore } from "@/stores/uiStore";

interface BusinessInsightsProps {
  scenarioId: string;
  onClose: () => void;
  onMinimize?: () => void;
  /** If provided, display immediately instead of fetching */
  preloaded?: BusinessInsight | null;
  /** Keep parent store in sync when analysis is loaded or regenerated */
  onInsightChange?: (insight: BusinessInsight) => void;
}

// ── Visual helpers ──

const SEVERITY_STYLES: Record<string, { bg: string; text: string; icon: string; border: string }> = {
  positive: { bg: "bg-[var(--success-bg)]", text: "text-[var(--success)]", icon: "\u2191", border: "border-l-[var(--success)]" },
  negative: { bg: "bg-[var(--danger-bg)]", text: "text-[var(--danger)]", icon: "\u2193", border: "border-l-[var(--danger)]" },
  neutral: { bg: "bg-[var(--panel-bg)]", text: "text-[var(--text-secondary)]", icon: "\u2192", border: "border-l-[var(--text-faint)]" },
};

const PRIORITY_STYLES: Record<string, { border: string; badge: string; label: string }> = {
  immediate: { border: "border-l-[var(--danger)]", badge: "bg-[var(--danger-bg)] text-[var(--danger)]", label: "Immediate" },
  "short-term": { border: "border-l-[var(--warning)]", badge: "bg-[var(--warning-bg)] text-[var(--warning)]", label: "Short-term" },
  monitor: { border: "border-l-[var(--info)]", badge: "bg-[var(--info-bg)] text-[var(--info)]", label: "Monitor" },
};

const LIKELIHOOD_STYLES: Record<string, string> = {
  high: "text-[var(--danger)]",
  medium: "text-[var(--warning)]",
  low: "text-[var(--info)]",
};

function ImplicationCard({ item }: { item: BusinessImplication }) {
  const style = SEVERITY_STYLES[item.severity] || SEVERITY_STYLES.neutral;
  return (
    <div className={`rounded-xl p-3.5 ${style.bg} border-l-4 ${style.border}`}>
      <div className={`flex items-start gap-2 ${style.text}`}>
        <span className="text-base mt-0.5 shrink-0">{style.icon}</span>
        <div>
          <p className="text-xs font-semibold">{item.title}</p>
          <p className="text-xs mt-1 opacity-80">{item.detail}</p>
        </div>
      </div>
    </div>
  );
}

function RiskCard({ item }: { item: BusinessRisk }) {
  const lStyle = LIKELIHOOD_STYLES[item.likelihood] || "";
  return (
    <div className="rounded-xl border border-[var(--card-border)] bg-[var(--card-bg)] p-3.5 shadow-card hover:shadow-card-hover transition-shadow">
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-medium flex-1 text-[var(--text-primary)]">{item.risk}</p>
        <span className={`text-[10px] font-semibold uppercase whitespace-nowrap ${lStyle}`}>
          {item.likelihood}
        </span>
      </div>
      <p className="text-xs text-[var(--text-muted)] mt-1.5">
        <span className="font-medium text-[var(--text-secondary)]">Mitigation:</span> {item.mitigation}
      </p>
    </div>
  );
}

function RecommendationCard({
  item,
  index,
  onCta,
}: {
  item: BusinessRecommendation;
  index: number;
  onCta?: (cta: NonNullable<BusinessRecommendation["cta"]>) => void;
}) {
  const style = PRIORITY_STYLES[item.priority] || PRIORITY_STYLES.monitor;
  const ctaLabel =
    item.cta === "open_doc_manager_model" || item.cta === "open_doc_manager"
      ? "Open Document Manager"
      : item.cta === "open_review"
        ? "Review & Re-run"
        : item.cta === "refresh_analysis"
          ? "Refresh analysis"
          : null;

  return (
    <div className={`rounded-xl border border-[var(--card-border)] bg-[var(--card-bg)] border-l-4 ${style.border} p-3.5 shadow-card`}>
      <div className="flex items-start gap-2">
        <span className="text-xs font-bold text-[var(--text-faint)] mt-0.5 w-5 shrink-0">
          {index + 1}.
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-xs font-semibold text-[var(--text-primary)]">{item.action}</p>
            <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${style.badge}`}>
              {style.label}
            </span>
            {item.owner && (
              <span className="text-[10px] text-[var(--text-faint)]">
                → {item.owner}
              </span>
            )}
          </div>
          <p className="text-xs text-[var(--text-muted)] mt-1">{item.rationale}</p>
          {item.cta && ctaLabel && onCta && (
            <button
              type="button"
              onClick={() => onCta(item.cta!)}
              className="mt-2.5 inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[11px] font-semibold text-white hover:bg-accent-hover transition-colors"
            >
              {ctaLabel}
              <span aria-hidden>→</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function IntegrityRemediationBanner({
  reasons,
  onFixModel,
  onReview,
  onRefresh,
}: {
  reasons?: string[];
  onFixModel: () => void;
  onReview: () => void;
  onRefresh: () => void;
}) {
  return (
    <section className="rounded-xl border border-[var(--warning)]/40 bg-[var(--warning-bg)] p-4 space-y-3">
      <div className="flex items-start gap-2.5">
        <div className="w-7 h-7 rounded-lg bg-[var(--warning)]/15 flex items-center justify-center shrink-0 mt-0.5">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-[var(--warning)]">
            <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
        </div>
        <div className="min-w-0">
          <p className="text-xs font-semibold text-[var(--warning)]">Remediation required — baseline integrity failure</p>
          <p className="text-[11px] text-[var(--text-secondary)] mt-1 leading-relaxed">
            {reasons?.[0] ||
              "Base P&L is missing or ~0, so % deltas are math artifacts. Fix the model baseline, re-run the scenario, then refresh this analysis before making decisions."}
          </p>
        </div>
      </div>
      <ol className="space-y-2 pl-1">
        <li className="flex flex-wrap items-center gap-2 text-[11px] text-[var(--text-secondary)]">
          <span className="font-semibold text-[var(--text-primary)] w-4">1.</span>
          <span className="flex-1 min-w-[12rem]">Load or correct non-zero base P&L in Document Manager → Model</span>
          <button
            type="button"
            onClick={onFixModel}
            className="rounded-lg bg-accent px-3 py-1.5 text-[11px] font-semibold text-white hover:bg-accent-hover"
          >
            Open Model
          </button>
        </li>
        <li className="flex flex-wrap items-center gap-2 text-[11px] text-[var(--text-secondary)]">
          <span className="font-semibold text-[var(--text-primary)] w-4">2.</span>
          <span className="flex-1 min-w-[12rem]">Re-approve parameters and run the scenario against the fixed baseline</span>
          <button
            type="button"
            onClick={onReview}
            className="rounded-lg border border-[var(--border)] bg-[var(--card-bg)] px-3 py-1.5 text-[11px] font-semibold text-[var(--text-primary)] hover:bg-[var(--panel-bg)]"
          >
            Review &amp; Run
          </button>
        </li>
        <li className="flex flex-wrap items-center gap-2 text-[11px] text-[var(--text-secondary)]">
          <span className="font-semibold text-[var(--text-primary)] w-4">3.</span>
          <span className="flex-1 min-w-[12rem]">Refresh So What? to replace this integrity warning with impact analysis</span>
          <button
            type="button"
            onClick={onRefresh}
            className="rounded-lg border border-[var(--border)] bg-[var(--card-bg)] px-3 py-1.5 text-[11px] font-semibold text-[var(--text-primary)] hover:bg-[var(--panel-bg)]"
          >
            Refresh analysis
          </button>
        </li>
      </ol>
    </section>
  );
}

export function BusinessInsights({ scenarioId, onClose, onMinimize, preloaded, onInsightChange }: BusinessInsightsProps) {
  const [insight, setInsight] = useState<BusinessInsight | null>(preloaded || null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadedForRef = useRef<string | null>(null);
  const openDocManagerModel = useUiStore((s) => s.openDocManagerModel);
  const openDocManagerForValidation = useUiStore((s) => s.openDocManagerForValidation);
  const openReviewForRerun = useUiStore((s) => s.openReviewForRerun);

  // Restore persisted analysis once per scenario (avoid remount / store-sync fetch storms)
  useEffect(() => {
    let cancelled = false;

    if (preloaded) {
      setInsight(preloaded);
      loadedForRef.current = scenarioId;
      setLoading(false);
      return;
    }

    if (loadedForRef.current === scenarioId) return;
    loadedForRef.current = scenarioId;

    (async () => {
      setLoading(true);
      setError(null);
      try {
        const stored = await getBusinessAnalysis(scenarioId);
        if (cancelled) return;
        if (stored) setInsight(stored);
      } catch (e) {
        if (!cancelled) {
          loadedForRef.current = null;
          setError((e as Error).message);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-fetch when scenario changes
  }, [scenarioId]);

  const run = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await generateBusinessAnalysis(scenarioId);
      setInsight(data);
      loadedForRef.current = scenarioId;
      onInsightChange?.(data);
    } catch (e) {
      setError((e as Error).message);
    }
    setLoading(false);
  }, [scenarioId, onInsightChange]);

  const handleCta = useCallback(
    (cta: NonNullable<BusinessRecommendation["cta"]>) => {
      if (cta === "open_doc_manager_model") openDocManagerModel();
      else if (cta === "open_doc_manager") openDocManagerForValidation();
      else if (cta === "open_review") openReviewForRerun();
      else if (cta === "refresh_analysis") void run();
    },
    [openDocManagerModel, openDocManagerForValidation, openReviewForRerun, run],
  );

  const isIntegrity =
    insight?.analysis_mode === "integrity" ||
    (!!insight && /baseline|zero[\s-]?base|math artifact|reload.*base|fix model setup/i.test(insight.headline));

  return (
    <div className="border-t border-[var(--border)] bg-background max-h-[70vh] overflow-auto">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-background border-b border-[var(--border-light)] px-4 py-3">
        <PanelHeader
          title={<>Business Analysis &mdash; &ldquo;So What?&rdquo;</>}
          icon={<div className="w-7 h-7 rounded-lg deloitte-gradient flex items-center justify-center shadow-sm"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5"><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></svg></div>}
          onClose={onClose}
          onMinimize={onMinimize || onClose}
          isMinimized={false}
          actions={
            <>
              {(!insight || error) && (
                <button
                  onClick={run}
                  disabled={loading}
                  className="rounded-lg bg-accent px-4 py-1.5 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-40 shadow-sm transition-colors"
                >
                  {loading ? "Analyzing..." : "Generate Analysis"}
                </button>
              )}
              {insight && !loading && (
                <button
                  onClick={run}
                  className="rounded-lg border border-[var(--border)] px-3 py-1 text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--panel-bg)] transition-colors"
                >
                  Refresh
                </button>
              )}
            </>
          }
        />
      </div>

      {error && (
        <div className="px-4 py-3">
          <p className="text-xs text-[var(--danger)] bg-[var(--danger-bg)] px-3 py-1.5 rounded-lg">{error}</p>
        </div>
      )}

      {loading && !insight && (
        <div className="px-4 py-8 text-center">
          <div className="inline-block w-6 h-6 border-2 border-accent/30 border-t-accent rounded-full animate-spin mb-3" />
          <p className="text-xs text-[var(--text-muted)]">
            {preloaded ? "Analyzing scenario impact..." : "Loading saved analysis..."}
          </p>
        </div>
      )}

      {!loading && !insight && !error && (
        <div className="px-4 py-8 text-center">
          <p className="text-xs text-[var(--text-muted)] mb-3">
            No saved business analysis for this scenario yet.
          </p>
          <button
            onClick={run}
            disabled={loading}
            className="rounded-lg bg-accent px-4 py-1.5 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-40 shadow-sm transition-colors"
          >
            Generate Analysis
          </button>
        </div>
      )}

      {insight && (
        <div className="px-4 py-5 space-y-5">
          {/* Headline */}
          <div className="rounded-xl bg-accent/5 border border-accent/15 p-4">
            <p className="text-sm font-semibold leading-relaxed text-[var(--text-primary)]">{insight.headline}</p>
          </div>

          {isIntegrity && (
            <IntegrityRemediationBanner
              reasons={insight.mode_reasons}
              onFixModel={openDocManagerModel}
              onReview={openReviewForRerun}
              onRefresh={() => void run()}
            />
          )}

          {/* Implications */}
          <section>
            <h4 className="text-[11px] font-semibold text-[var(--text-faint)] uppercase tracking-wider mb-2.5">
              What This Means
            </h4>
            <div className="grid gap-2">
              {insight.implications.map((item, i) => (
                <ImplicationCard key={i} item={item} />
              ))}
            </div>
          </section>

          {/* Risks */}
          <section>
            <h4 className="text-[11px] font-semibold text-[var(--text-faint)] uppercase tracking-wider mb-2.5">
              Risks &amp; Watch-Outs
            </h4>
            <div className="grid gap-2">
              {insight.risks.map((item, i) => (
                <RiskCard key={i} item={item} />
              ))}
            </div>
          </section>

          {/* Recommendations */}
          <section>
            <h4 className="text-[11px] font-semibold text-[var(--text-faint)] uppercase tracking-wider mb-2.5">
              Recommended Actions
            </h4>
            <div className="grid gap-2">
              {insight.recommendations.map((item, i) => (
                <RecommendationCard key={i} item={item} index={i} onCta={handleCta} />
              ))}
            </div>
          </section>

          {/* Decision Context */}
          <section className="rounded-xl border-2 border-accent/20 bg-accent/5 p-4">
            <h4 className="text-xs font-semibold text-accent mb-1.5">Decision Framework</h4>
            <div className="text-xs [&_p]:mb-1.5 leading-relaxed text-[var(--text-secondary)]">
              <MarkdownContent content={insight.decision_context} />
            </div>
          </section>

          {/* QA-BA Reflection Log */}
          {insight.reflection_log && insight.reflection_log.length > 0 && (
            <ReflectionLogSection steps={insight.reflection_log} />
          )}

          {/* QA Report */}
          {insight.qa_report && <QAReportSection report={insight.qa_report} />}

          {/* Confidence */}
          <div className="text-[11px] text-[var(--text-faint)] italic px-1 pb-2">
            {insight.confidence_note}
          </div>
        </div>
      )}
    </div>
  );
}

function ReflectionLogSection({ steps }: { steps: ReflectionStep[] }) {
  const [expanded, setExpanded] = useState(true);
  const hasFailure = steps.some((s) => s.passed === false);
  const totalIterations = steps.filter((s) => s.agent === "Quality Assurance").length;

  return (
    <section className="rounded-xl border border-[var(--card-border)] bg-[var(--card-bg)] overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-[var(--panel-bg)] transition-colors"
      >
        <div className="flex items-center gap-2.5">
          <div className={`w-6 h-6 rounded-lg ${hasFailure ? "bg-[var(--warning-bg)]" : "bg-accent/10"} flex items-center justify-center`}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={hasFailure ? "text-[var(--warning)]" : "text-accent"}>
              <path d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.66 0 3-4.03 3-9s-1.34-9-3-9m0 18c-1.66 0-3-4.03-3-9s1.34-9 3-9" />
            </svg>
          </div>
          <span className="text-xs font-semibold text-[var(--text-primary)]">
            Agent Reflection Loop
          </span>
          <span className="text-[10px] text-[var(--text-faint)]">
            {steps.length} steps, {totalIterations} QA {totalIterations === 1 ? "review" : "reviews"}
          </span>
        </div>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className={`transition-transform ${expanded ? "rotate-180" : ""} text-[var(--text-faint)]`}>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {expanded && (
        <div className="px-4 pb-4 border-t border-[var(--border-light)]">
          <div className="relative mt-3">
            {/* Timeline line */}
            <div className="absolute left-[11px] top-2 bottom-2 w-px bg-[var(--border)]" />

            <div className="space-y-3">
              {steps.map((step, i) => {
                const isBA = step.agent === "Business Analysis";
                const isQA = step.agent === "Quality Assurance";
                const isFail = step.passed === false;
                const isPass = step.passed === true;

                let dotColor = "bg-accent";
                if (isQA && isPass) dotColor = "bg-[var(--success)]";
                if (isQA && isFail) dotColor = "bg-[var(--danger)]";

                let borderAccent = "border-l-accent/30";
                if (isQA && isPass) borderAccent = "border-l-[var(--success)]/30";
                if (isQA && isFail) borderAccent = "border-l-[var(--danger)]/30";

                return (
                  <div key={i} className="relative pl-7">
                    {/* Dot on timeline */}
                    <div className={`absolute left-[7px] top-2.5 w-[9px] h-[9px] rounded-full ${dotColor} ring-2 ring-[var(--card-bg)]`} />

                    <div className={`rounded-lg border-l-[3px] ${borderAccent} bg-[var(--panel-bg)] px-3 py-2.5`}>
                      <div className="flex items-center gap-2 mb-1">
                        <span className={`text-[10px] font-bold uppercase tracking-wider ${isBA ? "text-accent" : isPass ? "text-[var(--success)]" : isFail ? "text-[var(--danger)]" : "text-[var(--warning)]"}`}>
                          {step.agent}
                        </span>
                        {step.score != null && (
                          <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${
                            step.score >= 7 ? "bg-[var(--success-bg)] text-[var(--success)]"
                            : step.score >= 5 ? "bg-[var(--warning-bg)] text-[var(--warning)]"
                            : "bg-[var(--danger-bg)] text-[var(--danger)]"
                          }`}>
                            {step.score}/10
                          </span>
                        )}
                        {step.passed === true && (
                          <span className="text-[10px] font-semibold text-[var(--success)]">PASSED</span>
                        )}
                        {step.passed === false && (
                          <span className="text-[10px] font-semibold text-[var(--danger)]">FAILED</span>
                        )}
                        <span className="text-[9px] text-[var(--text-faint)] ml-auto">
                          {step.duration_ms > 0 ? `${(step.duration_ms / 1000).toFixed(1)}s` : ""}
                        </span>
                      </div>
                      <p className="text-[11px] font-medium text-[var(--text-secondary)]">{step.action}</p>
                      <p className="text-[10px] text-[var(--text-muted)] mt-0.5 leading-relaxed">{step.detail}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function QAScoreBar({ score }: { score: number }) {
  const pct = (score / 10) * 100;
  const color = score >= 7 ? "bg-[var(--success)]" : score >= 5 ? "bg-[var(--warning)]" : "bg-[var(--danger)]";
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 rounded-full bg-[var(--border)]">
        <div className={`h-full rounded-full ${color} transition-all`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[10px] font-semibold w-6 text-right text-[var(--text-secondary)]">{score}/10</span>
    </div>
  );
}

function QAReportSection({ report }: { report: QAReport }) {
  const notAssessed = report.status === "not_assessed";
  const hasError = !notAssessed && (report.overall_score === 0 || report.dimensions.some((d) => d.name === "qa_error"));
  const [expanded, setExpanded] = useState(notAssessed || hasError || !report.passed);
  const scoreColor = notAssessed
    ? "text-[var(--warning)]"
    : hasError
      ? "text-[var(--danger)]"
      : report.overall_score >= 7
        ? "text-[var(--success)]"
        : report.overall_score >= 5
          ? "text-[var(--warning)]"
          : "text-[var(--danger)]";
  const scoreBg = notAssessed
    ? "bg-[var(--warning-bg)]"
    : hasError
      ? "bg-[var(--danger-bg)]"
      : report.overall_score >= 7
        ? "bg-[var(--success-bg)]"
        : report.overall_score >= 5
          ? "bg-[var(--warning-bg)]"
          : "bg-[var(--danger-bg)]";
  const borderColor = notAssessed
    ? "border-[var(--warning)]/40"
    : hasError
      ? "border-[var(--danger)]/40"
      : "border-[var(--card-border)]";

  return (
    <section className={`rounded-xl border ${borderColor} bg-[var(--card-bg)] overflow-hidden`}>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-[var(--panel-bg)] transition-colors"
      >
        <div className="flex items-center gap-2.5">
          <div className={`w-6 h-6 rounded-lg ${scoreBg} flex items-center justify-center`}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className={scoreColor}>
              {notAssessed
                ? <><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></>
                : report.passed && !hasError
                  ? <polyline points="20 6 9 17 4 12" />
                  : <><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></>
              }
            </svg>
          </div>
          <span className="text-xs font-semibold text-[var(--text-primary)]">
            {notAssessed ? (
              <span className={scoreColor}>Quality Assurance</span>
            ) : hasError ? (
              <span className={scoreColor}>{strings.qa.error}</span>
            ) : (
              <>{strings.qa.label}: <span className={scoreColor}>{report.overall_score}/10</span></>
            )}
          </span>
          {notAssessed && (
            <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-[var(--warning-bg)] text-[var(--warning)] border border-[var(--warning)]/30">
              {strings.qa.notAssessed}
            </span>
          )}
          {report.iterations > 0 && !hasError && !notAssessed && (
            <span className="text-[10px] text-[var(--text-faint)]">
              ({report.iterations} {report.iterations === 1 ? "review" : "reviews"})
            </span>
          )}
        </div>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className={`transition-transform ${expanded ? "rotate-180" : ""} text-[var(--text-faint)]`}>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {expanded && (
        <div className="px-4 pb-4 space-y-3 border-t border-[var(--border-light)]">
          <p className={`text-xs mt-3 ${notAssessed || hasError ? "text-[var(--warning)]" : "text-[var(--text-secondary)]"}`}>{report.summary}</p>

          {report.dimensions.length > 0 && (
            <div className="grid gap-2">
              {report.dimensions.map((d) => (
                <div key={d.name} className="rounded-lg bg-[var(--panel-bg)] px-3 py-2">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-faint)]">
                      {d.name.replace(/_/g, " ")}
                    </span>
                  </div>
                  <QAScoreBar score={d.score} />
                  <p className="text-[10px] text-[var(--text-muted)] mt-1">{d.feedback}</p>
                </div>
              ))}
            </div>
          )}

          {report.improvement_guidance && !report.passed && (
            <div className="rounded-lg bg-[var(--warning-bg)] border border-[var(--warning)]/20 px-3 py-2">
              <p className="text-[10px] font-semibold text-[var(--warning)] mb-1">Improvement Guidance</p>
              <div className="text-[10px] text-[var(--text-secondary)] [&_p]:mb-1">
                <MarkdownContent content={report.improvement_guidance} />
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
