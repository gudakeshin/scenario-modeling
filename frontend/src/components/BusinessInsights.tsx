"use client";

import { useState, useCallback } from "react";
import { PanelHeader } from "./PanelHeader";
import {
  generateBusinessAnalysis,
  type BusinessInsight,
  type BusinessImplication,
  type BusinessRisk,
  type BusinessRecommendation,
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

          {/* Confidence */}
          <div className="text-[11px] text-[var(--text-faint)] italic px-1 pb-2">
            {insight.confidence_note}
          </div>
        </div>
      )}
    </div>
  );
}
