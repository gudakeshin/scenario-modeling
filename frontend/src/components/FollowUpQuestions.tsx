"use client";

import { useState, useCallback } from "react";
import type { FollowUpQuestion } from "@/lib/api";

interface FollowUpQuestionsProps {
  questions: FollowUpQuestion[];
  onSubmit: (answers: { question_id: string; answer: string }[]) => void;
  isLoading?: boolean;
}

/**
 * Interactive follow-up questions panel.
 * Renders each question with clickable option buttons + optional custom text input.
 * The user selects answers, then submits all at once to refine the scenario.
 */
export function FollowUpQuestions({ questions, onSubmit, isLoading }: FollowUpQuestionsProps) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [customInputs, setCustomInputs] = useState<Record<string, string>>({});
  const [showCustom, setShowCustom] = useState<Record<string, boolean>>({});

  const handleOptionSelect = useCallback((questionId: string, value: string) => {
    setAnswers((prev) => ({ ...prev, [questionId]: value }));
    // If they pick an option, hide custom input
    setShowCustom((prev) => ({ ...prev, [questionId]: false }));
  }, []);

  const handleCustomToggle = useCallback((questionId: string) => {
    setShowCustom((prev) => ({ ...prev, [questionId]: !prev[questionId] }));
  }, []);

  const handleCustomChange = useCallback((questionId: string, value: string) => {
    setCustomInputs((prev) => ({ ...prev, [questionId]: value }));
    setAnswers((prev) => ({ ...prev, [questionId]: value }));
  }, []);

  const handleSubmit = useCallback(() => {
    const answeredQuestions = questions
      .filter((q) => answers[q.id])
      .map((q) => ({ question_id: q.id, answer: answers[q.id] }));

    if (answeredQuestions.length === 0) return;
    onSubmit(answeredQuestions);
  }, [questions, answers, onSubmit]);

  const answeredCount = questions.filter((q) => answers[q.id]).length;

  return (
    <div className="mx-4 mb-3 rounded-xl border border-accent/30 bg-accent/5 overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-accent/20 bg-accent/10">
        <div className="flex items-center gap-2">
          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <h3 className="text-sm font-semibold text-accent">Help me refine this scenario</h3>
        </div>
        <p className="text-xs text-[var(--text-secondary)] mt-1">
          Answer the questions below to generate more precise parameters. Select an option or type your own.
        </p>
      </div>

      {/* Questions */}
      <div className="p-4 space-y-5 max-h-[50vh] overflow-y-auto">
        {questions.map((q, idx) => (
          <div key={q.id} className="space-y-2">
            <p className="text-sm font-medium text-[var(--text-primary)]">
              <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-accent/20 text-accent text-xs font-bold mr-2">
                {idx + 1}
              </span>
              {q.question}
            </p>

            {/* Option buttons */}
            <div className="flex flex-wrap gap-2 ml-7">
              {q.options.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => handleOptionSelect(q.id, opt.value)}
                  disabled={isLoading}
                  className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-all ${
                    answers[q.id] === opt.value && !showCustom[q.id]
                      ? "bg-accent text-white border-accent shadow-sm"
                      : "border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--panel-bg)] hover:border-accent/40"
                  } disabled:opacity-40`}
                >
                  {opt.label}
                </button>
              ))}
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

            {/* Custom text input */}
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

            {/* Selection indicator */}
            {answers[q.id] && (
              <p className="text-xs text-accent/70 ml-7">
                Selected: <span className="font-medium">{answers[q.id]}</span>
              </p>
            )}
          </div>
        ))}
      </div>

      {/* Submit footer */}
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
          {isLoading ? "Refining..." : "Refine Scenario"}
        </button>
      </div>
    </div>
  );
}
