"use client";

import { useState, useCallback } from "react";
import { PanelHeader } from "./PanelHeader";
import {
  generateBusinessAnalysis,
  type BusinessInsight,
  type BusinessImplication,
  type BusinessRisk,
  type BusinessRecommendation,
  type QAReport,
  type ReflectionStep,
} from "@/lib/api";

interface BusinessInsightsProps {
  scenarioId: string;
  onClose: () => void;
  onMinimize?: () => void;
  /** If provided, display immediately instead of fetching */
  preloaded?: BusinessInsight | null;
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

function RecommendationCard({ item, index }: { item: BusinessRecommendation; index: number }) {
  const style = PRIORITY_STYLES[item.priority] || PRIORITY_STYLES.monitor;
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
                \u2192 {item.owner}
              </span>
            )}
          </div>
          <p className="text-xs text-[var(--text-muted)] mt-1">{item.rationale}</p>
        </div>
      </div>
    </div>
  );
}

export function BusinessInsights({ scenarioId, onClose, onMinimize, preloaded }: BusinessInsightsProps) {
  const [insight, setInsight] = useState<BusinessInsight | null>(preloaded || null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await generateBusinessAnalysis(scenarioId);
      setInsight(data);
    } catch (e) {
      setError((e as Error).message);
    }
    setLoading(false);
  }, [scenarioId]);

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
          <p className="text-xs text-[var(--text-muted)]">Analyzing scenario impact...</p>
        </div>
      )}

      {insight && (
        <div className="px-4 py-5 space-y-5">
          {/* Headline */}
          <div className="rounded-xl bg-accent/5 border border-accent/15 p-4">
            <p className="text-sm font-semibold leading-relaxed text-[var(--text-primary)]">{insight.headline}</p>
          </div>

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
                <RecommendationCard key={i} item={item} index={i} />
              ))}
            </div>
          </section>

          {/* Decision Context */}
          <section className="rounded-xl border-2 border-accent/20 bg-accent/5 p-4">
            <h4 className="text-xs font-semibold text-accent mb-1.5">Decision Framework</h4>
            <p className="text-xs leading-relaxed text-[var(--text-secondary)]">{insight.decision_context}</p>
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
  const hasError = report.overall_score === 0 || report.dimensions.some((d) => d.name === "qa_error");
  const [expanded, setExpanded] = useState(hasError || !report.passed);
  const scoreColor = hasError ? "text-[var(--danger)]" : report.overall_score >= 7 ? "text-[var(--success)]" : report.overall_score >= 5 ? "text-[var(--warning)]" : "text-[var(--danger)]";
  const scoreBg = hasError ? "bg-[var(--danger-bg)]" : report.overall_score >= 7 ? "bg-[var(--success-bg)]" : report.overall_score >= 5 ? "bg-[var(--warning-bg)]" : "bg-[var(--danger-bg)]";
  const borderColor = hasError ? "border-[var(--danger)]/40" : "border-[var(--card-border)]";

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
              {report.passed && !hasError
                ? <polyline points="20 6 9 17 4 12" />
                : <><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></>
              }
            </svg>
          </div>
          <span className="text-xs font-semibold text-[var(--text-primary)]">
            {hasError ? (
              <span className={scoreColor}>Quality Assurance: Error</span>
            ) : (
              <>Quality Assurance: <span className={scoreColor}>{report.overall_score}/10</span></>
            )}
          </span>
          {report.iterations > 0 && !hasError && (
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
          <p className={`text-xs mt-3 ${hasError ? "text-[var(--danger)]" : "text-[var(--text-secondary)]"}`}>{report.summary}</p>

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
              <p className="text-[10px] text-[var(--text-secondary)] whitespace-pre-wrap">{report.improvement_guidance}</p>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
