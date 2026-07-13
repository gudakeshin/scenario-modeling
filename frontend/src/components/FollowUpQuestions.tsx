"use client";

import { useState, useCallback, useEffect, useMemo } from "react";
import type { FollowUpAnswer, FollowUpQuestion } from "@/lib/api";

interface FollowUpQuestionsProps {
  questions: FollowUpQuestion[];
  onSubmit: (answers: FollowUpAnswer[]) => void;
  isLoading?: boolean;
}

function isOpenQuestion(q: FollowUpQuestion): boolean {
  return q.question_type === "open" || q.options.length === 0;
}

function buildInitialAnswers(questions: FollowUpQuestion[]): Record<string, string> {
  const init: Record<string, string> = {};
  for (const q of questions) {
    if (q.recommendation?.value) {
      init[q.id] = q.recommendation.value;
    }
  }
  return init;
}

function evidenceKindLabel(kind: string): string {
  switch (kind) {
    case "model":
      return "Model";
    case "document":
      return "Doc";
    case "context":
      return "Context";
    case "web":
      return "Web";
    default:
      return kind;
  }
}

/**
 * Interactive follow-up questions panel.
 * Pre-selects LLM recommendations when present; user confirms, overrides, or comments.
 */
export function FollowUpQuestions({ questions, onSubmit, isLoading }: FollowUpQuestionsProps) {
  const [answers, setAnswers] = useState<Record<string, string>>(() => buildInitialAnswers(questions));
  const [customInputs, setCustomInputs] = useState<Record<string, string>>({});
  const [showCustom, setShowCustom] = useState<Record<string, boolean>>({});
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [expandedEvidence, setExpandedEvidence] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setAnswers(buildInitialAnswers(questions));
    setCustomInputs({});
    setShowCustom({});
    setTouched({});
    setExpandedEvidence({});
  }, [questions]);

  const recommendedCount = useMemo(
    () => questions.filter((q) => q.recommendation?.value).length,
    [questions],
  );

  const allMatchRecommendations = useMemo(() => {
    if (recommendedCount === 0) return false;
    return questions.every((q) => {
      const answer = answers[q.id];
      if (!answer) return false;
      if (!q.recommendation) return true;
      return answer === q.recommendation.value && !showCustom[q.id];
    });
  }, [questions, answers, showCustom, recommendedCount]);

  const handleOptionSelect = useCallback((questionId: string, value: string) => {
    setAnswers((prev) => ({ ...prev, [questionId]: value }));
    setTouched((prev) => ({ ...prev, [questionId]: true }));
    setShowCustom((prev) => ({ ...prev, [questionId]: false }));
  }, []);

  const handleCustomToggle = useCallback((questionId: string) => {
    setShowCustom((prev) => ({ ...prev, [questionId]: !prev[questionId] }));
    setTouched((prev) => ({ ...prev, [questionId]: true }));
  }, []);

  const handleCustomChange = useCallback((questionId: string, value: string) => {
    setCustomInputs((prev) => ({ ...prev, [questionId]: value }));
    setAnswers((prev) => ({ ...prev, [questionId]: value }));
    setTouched((prev) => ({ ...prev, [questionId]: true }));
  }, []);

  const handleOpenComment = useCallback((questionId: string, value: string) => {
    setAnswers((prev) => ({ ...prev, [questionId]: value }));
    setTouched((prev) => ({ ...prev, [questionId]: true }));
  }, []);

  const acceptAllRecommendations = useCallback(() => {
    setAnswers((prev) => {
      const next = { ...prev };
      for (const q of questions) {
        if (q.recommendation?.value) {
          next[q.id] = q.recommendation.value;
        }
      }
      return next;
    });
    setShowCustom((prev) => {
      const next = { ...prev };
      for (const q of questions) {
        if (q.recommendation?.value) next[q.id] = false;
      }
      return next;
    });
    setTouched((prev) => {
      const next = { ...prev };
      for (const q of questions) {
        if (q.recommendation?.value) delete next[q.id];
      }
      return next;
    });
  }, [questions]);

  const handleSubmit = useCallback(() => {
    const payload: FollowUpAnswer[] = [];
    for (const q of questions) {
      const answer = answers[q.id];
      if (!answer?.trim()) continue;

      if (isOpenQuestion(q)) {
        payload.push({ question_id: q.id, answer, answer_kind: "comment" });
        continue;
      }

      if (showCustom[q.id]) {
        payload.push({ question_id: q.id, answer, answer_kind: "custom" });
        continue;
      }

      if (q.recommendation) {
        if (answer === q.recommendation.value) {
          payload.push({
            question_id: q.id,
            answer,
            answer_kind: "accepted_recommendation",
          });
        } else {
          payload.push({
            question_id: q.id,
            answer,
            answer_kind: "overridden",
            recommended_value: q.recommendation.value,
          });
        }
        continue;
      }

      payload.push({ question_id: q.id, answer });
    }

    if (payload.length === 0) return;
    onSubmit(payload);
  }, [questions, answers, showCustom, onSubmit]);

  const answeredCount = questions.filter((q) => answers[q.id]?.trim()).length;
  const submitLabel = isLoading
    ? "Refining..."
    : allMatchRecommendations
      ? "Confirm & Refine"
      : "Refine Scenario";

  return (
    <div className="mx-4 mb-3 rounded-xl border border-accent/30 bg-accent/5 overflow-hidden">
      <div className="px-4 py-3 border-b border-accent/20 bg-accent/10">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-accent shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <h3 className="text-sm font-semibold text-accent truncate">Help me refine this scenario</h3>
          </div>
          {recommendedCount >= 2 && (
            <button
              type="button"
              onClick={acceptAllRecommendations}
              disabled={isLoading}
              className="shrink-0 rounded-lg border border-accent/40 bg-accent/10 px-2.5 py-1 text-[11px] font-medium text-accent hover:bg-accent/20 transition-all disabled:opacity-40"
            >
              Accept all recommendations
            </button>
          )}
        </div>
        <p className="text-xs text-[var(--text-secondary)] mt-1">
          {recommendedCount > 0
            ? "Recommended impacts are pre-selected from your model and documents. Confirm, override, or comment."
            : "Answer the questions below to generate more precise parameters. Select an option or type your own."}
        </p>
      </div>

      <div className="p-4 space-y-5 max-h-[50vh] overflow-y-auto">
        {questions.map((q, idx) => {
          const rec = q.recommendation;
          const open = isOpenQuestion(q);
          const isRecSelected =
            !!rec && answers[q.id] === rec.value && !showCustom[q.id];

          return (
            <div key={q.id} className="space-y-2">
              <p className="text-sm font-medium text-[var(--text-primary)]">
                <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-accent/20 text-accent text-xs font-bold mr-2">
                  {idx + 1}
                </span>
                {q.question}
              </p>

              {rec && !open && (
                <div className="ml-7 space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="inline-flex items-center rounded-md bg-accent/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent">
                      Recommended
                    </span>
                    <span className="inline-flex items-center rounded-md bg-[var(--panel-bg)] border border-[var(--border)] px-1.5 py-0.5 text-[10px] font-mono text-[var(--text-secondary)]">
                      {Math.round(rec.confidence * 100)}% confident
                    </span>
                  </div>
                  <p className="text-xs text-[var(--text-secondary)] leading-relaxed">{rec.rationale}</p>
                  {rec.evidence.length > 0 && (
                    <div>
                      <button
                        type="button"
                        onClick={() =>
                          setExpandedEvidence((prev) => ({ ...prev, [q.id]: !prev[q.id] }))
                        }
                        className="text-[11px] font-medium text-accent hover:underline"
                      >
                        {expandedEvidence[q.id] ? "Hide why" : "Why?"}
                      </button>
                      {expandedEvidence[q.id] && (
                        <ul className="mt-1.5 space-y-1.5 border-l-2 border-accent/25 pl-3">
                          {rec.evidence.map((ev, i) => (
                            <li key={`${ev.source}-${i}`} className="text-[11px] text-[var(--text-secondary)]">
                              <span className="font-semibold text-[var(--text-primary)]">
                                [{evidenceKindLabel(ev.kind)}] {ev.source}
                              </span>
                              {ev.snippet ? (
                                <span className="block mt-0.5 text-[var(--text-faint)] leading-snug">
                                  {ev.snippet}
                                </span>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </div>
              )}

              {open ? (
                <div className="ml-7">
                  <textarea
                    value={answers[q.id] || ""}
                    onChange={(e) => handleOpenComment(q.id, e.target.value)}
                    placeholder="Describe the expected impact in your own words…"
                    disabled={isLoading}
                    rows={3}
                    className="w-full rounded-lg border border-[var(--border)] bg-background px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-faint)] focus:outline-none focus:border-accent/50 focus:ring-1 focus:ring-accent/30 disabled:opacity-40 resize-y min-h-[72px]"
                  />
                </div>
              ) : (
                <>
                  <div className="flex flex-wrap gap-2 ml-7">
                    {q.options.map((opt) => {
                      const isRecommended = rec?.value === opt.value;
                      const selected = answers[q.id] === opt.value && !showCustom[q.id];
                      return (
                        <button
                          key={opt.value}
                          type="button"
                          onClick={() => handleOptionSelect(q.id, opt.value)}
                          disabled={isLoading}
                          className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-all inline-flex items-center gap-1.5 ${
                            selected
                              ? isRecommended
                                ? "bg-accent/90 text-white border-accent shadow-sm ring-2 ring-accent/30"
                                : "bg-accent text-white border-accent shadow-sm"
                              : isRecommended
                                ? "border-accent/50 bg-accent/10 text-accent hover:bg-accent/20"
                                : "border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--panel-bg)] hover:border-accent/40"
                          } disabled:opacity-40`}
                        >
                          {opt.label}
                          {isRecommended && (
                            <span
                              className={`text-[9px] font-semibold uppercase tracking-wide px-1 py-0.5 rounded ${
                                selected ? "bg-white/20 text-white" : "bg-accent/20 text-accent"
                              }`}
                            >
                              Rec
                            </span>
                          )}
                        </button>
                      );
                    })}
                    {q.allow_custom !== false && (
                      <button
                        type="button"
                        onClick={() => handleCustomToggle(q.id)}
                        disabled={isLoading}
                        className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-all ${
                          showCustom[q.id]
                            ? "bg-[var(--panel-bg)] border-accent/40 text-accent"
                            : "border-dashed border-[var(--border)] text-[var(--text-faint)] hover:text-[var(--text-secondary)] hover:border-accent/30"
                        } disabled:opacity-40`}
                      >
                        Custom...
                      </button>
                    )}
                  </div>

                  {showCustom[q.id] && (
                    <div className="ml-7">
                      <input
                        type="text"
                        value={customInputs[q.id] || ""}
                        onChange={(e) => handleCustomChange(q.id, e.target.value)}
                        placeholder="Type your answer..."
                        disabled={isLoading}
                        className="w-full rounded-lg border border-[var(--border)] bg-background px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-faint)] focus:outline-none focus:border-accent/50 focus:ring-1 focus:ring-accent/30 disabled:opacity-40"
                      />
                    </div>
                  )}
                </>
              )}

              {answers[q.id] && !open && (
                <p className="text-xs text-accent/70 ml-7">
                  {isRecSelected && !touched[q.id]
                    ? "Pre-selected recommendation — confirm or change"
                    : (
                      <>
                        Selected: <span className="font-medium">{answers[q.id]}</span>
                      </>
                    )}
                </p>
              )}
            </div>
          );
        })}
      </div>

      <div className="px-4 py-3 border-t border-accent/20 bg-accent/5 flex items-center justify-between">
        <span className="text-xs text-[var(--text-secondary)]">
          {answeredCount} of {questions.length} answered
        </span>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={isLoading || answeredCount === 0}
          className="rounded-lg bg-accent px-4 py-2 text-xs font-semibold text-white shadow-sm hover:bg-accent/90 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {submitLabel}
        </button>
      </div>
    </div>
  );
}
