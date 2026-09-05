"use client";

import { useState } from "react";
import { fmtMetric, getCurrencyLabel, useCurrencyVersion } from "@/lib/metrics";

export interface CausalChainStep {
  step: string;
  detail?: string;
  kind?: "decomposition" | "research" | "levers" | "preview" | "other";
}

export interface AgentTraceStep {
  tool: string;
  input: unknown;
  output: unknown;
}

export interface AgentCitation {
  source: string;
  snippet?: string;
  url?: string;
}

export interface AgentConstraintViolation {
  lever: string;
  reason: string;
}

interface AgentTracePanelProps {
  causalChain?: CausalChainStep[];
  agentTrace?: AgentTraceStep[];
  confidence?: number;
  citations?: AgentCitation[];
  previewPl?: Record<string, number>;
  constraintViolations?: AgentConstraintViolation[];
  previewReconciliation?: {
    reconciled: boolean;
    max_abs_diff: number;
    message?: string;
  };
}

const KIND_LABEL: Record<string, string> = {
  decomposition: "Decompose",
  research: "Research",
  levers: "Levers",
  preview: "Preview",
  other: "Step",
};

/**
 * Collapsible panel showing the agentic reasoning causal chain
 * (decomposition → research → levers → preview), citations, and mini P&L.
 */
export function AgentTracePanel({
  causalChain,
  agentTrace,
  confidence,
  citations,
  previewPl,
  constraintViolations,
  previewReconciliation,
}: AgentTracePanelProps) {
  useCurrencyVersion();
  const [expanded, setExpanded] = useState(true);
  const [showTools, setShowTools] = useState(false);

  const hasPreview = previewPl && Object.keys(previewPl).length > 0;
  const hasCitations = citations && citations.length > 0;
  const hasViolations = constraintViolations && constraintViolations.length > 0;
  const hasReconciliation = !!previewReconciliation;

  if (
    (!causalChain || causalChain.length === 0) &&
    (!agentTrace || agentTrace.length === 0) &&
    !hasPreview &&
    !hasCitations &&
    !hasViolations &&
    !hasReconciliation &&
    confidence == null
  ) {
    return null;
  }

  const previewEntries = hasPreview
    ? Object.entries(previewPl!).slice(0, 8)
    : [];

  return (
    <div className="flex justify-start px-4 py-1.5">
      <div className="max-w-[85%] sm:max-w-[75%] w-full rounded-xl border border-[var(--border-light)] bg-[var(--panel-bg)]/70 px-3 py-2">
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="flex w-full items-center gap-2 text-left text-xs font-medium text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
          aria-expanded={expanded}
        >
          <span className="inline-flex h-2 w-2 rounded-full bg-accent" />
          <span>Agent reasoning</span>
          {confidence != null && (
            <span className="text-[10px] text-[var(--text-faint)]">
              {(confidence * 100).toFixed(0)}% confidence
            </span>
          )}
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            className={`ml-auto transition-transform ${expanded ? "rotate-180" : ""}`}
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>

        {expanded && (
          <div className="mt-2 space-y-2">
            {hasViolations && (
              <div className="rounded-lg border border-[var(--danger)]/30 bg-[var(--danger)]/5 px-2.5 py-2">
                <p className="text-[11px] font-semibold text-[var(--danger)]">Constraint violations</p>
                <ul className="mt-1 space-y-0.5">
                  {constraintViolations!.map((v, i) => (
                    <li key={i} className="text-[11px] text-[var(--text-secondary)]">
                      <span className="font-mono text-[var(--danger)]">{v.lever}</span>
                      {": "}
                      {v.reason}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {hasPreview && (
              <div className="rounded-lg border border-accent/20 bg-accent/5 px-2.5 py-2">
                <p className="text-[11px] font-semibold text-accent">
                  Preview P&amp;L{" "}
                  <span className="font-normal text-[var(--text-faint)]">
                    ({getCurrencyLabel()}, what-if — not a saved run)
                  </span>
                </p>
                {previewReconciliation && (
                  <p
                    className={`mt-1 text-[10px] ${
                      previewReconciliation.reconciled
                        ? "text-[var(--text-faint)]"
                        : "text-[var(--warning)]"
                    }`}
                  >
                    {previewReconciliation.message ||
                      (previewReconciliation.reconciled
                        ? "Preview reconciled with final levers"
                        : `Preview drift (max Δ ${previewReconciliation.max_abs_diff})`)}
                  </p>
                )}
                <dl className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-1">
                  {previewEntries.map(([k, v]) => (
                    <div key={k} className="flex justify-between gap-2 text-[11px]">
                      <dt className="truncate text-[var(--text-faint)]">{k}</dt>
                      <dd className="shrink-0 font-medium tabular-nums text-[var(--text-primary)]">
                        {fmtMetric(k, v)}
                      </dd>
                    </div>
                  ))}
                </dl>
                {Object.keys(previewPl!).length > 8 && (
                  <p className="mt-1 text-[10px] text-[var(--text-faint)]">
                    +{Object.keys(previewPl!).length - 8} more metrics
                  </p>
                )}
              </div>
            )}

            {causalChain && causalChain.length > 0 && (
              <ol className="space-y-1.5">
                {causalChain.map((c, i) => (
                  <li key={i} className="flex gap-2 text-[12px] text-[var(--text-secondary)]">
                    <span className="shrink-0 rounded bg-accent/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent">
                      {KIND_LABEL[c.kind || "other"] || "Step"}
                    </span>
                    <span>
                      <span className="font-medium text-[var(--text-primary)]">{c.step}</span>
                      {c.detail ? (
                        <span className="block text-[11px] text-[var(--text-faint)]">{c.detail}</span>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ol>
            )}

            {hasCitations && (
              <div>
                <p className="text-[11px] font-medium text-[var(--text-tertiary)]">Citations</p>
                <ul className="mt-1 space-y-1">
                  {citations!.map((c, i) => (
                    <li key={i} className="text-[11px] text-[var(--text-secondary)]">
                      {c.url ? (
                        <a
                          href={c.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-accent hover:underline"
                        >
                          {c.source}
                        </a>
                      ) : (
                        <span className="font-medium text-[var(--text-primary)]">{c.source}</span>
                      )}
                      {c.snippet ? (
                        <span className="block text-[10px] text-[var(--text-faint)] line-clamp-2">
                          {c.snippet}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {agentTrace && agentTrace.length > 0 && (
              <div>
                <button
                  type="button"
                  onClick={() => setShowTools((s) => !s)}
                  className="text-[11px] text-accent hover:underline"
                >
                  {showTools ? "Hide" : "Show"} tool trace ({agentTrace.length})
                </button>
                {showTools && (
                  <ul className="mt-1 space-y-1 max-h-40 overflow-y-auto">
                    {agentTrace.map((t, i) => (
                      <li
                        key={i}
                        className="rounded-md border border-[var(--border-light)] bg-background px-2 py-1 text-[11px] font-mono text-[var(--text-faint)]"
                      >
                        <span className="text-accent">{t.tool}</span>
                        {typeof t.output === "object" &&
                        t.output &&
                        ("error" in (t.output as object) || "blocked" in (t.output as object)) ? (
                          <span className="text-[var(--danger)]"> — blocked/error</span>
                        ) : (
                          <span> — ok</span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
