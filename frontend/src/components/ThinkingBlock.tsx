"use client";

import { useState, useEffect, useRef } from "react";
import type { ThinkingData } from "@/types/chat";

interface ThinkingBlockProps {
  data: ThinkingData;
}

/**
 * Collapsible "Thinking…" block that reveals the LLM's reasoning step-by-step,
 * similar to ChatGPT's visible thinking feature.
 */
export function ThinkingBlock({ data }: ThinkingBlockProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [displayedText, setDisplayedText] = useState("");
  const [isStreaming, setIsStreaming] = useState(true);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Typewriter streaming effect when first rendered
  useEffect(() => {
    if (!data.thinking) {
      setIsStreaming(false);
      return;
    }

    const fullText = data.thinking;
    let idx = 0;
    const speed = Math.max(8, Math.min(25, 2000 / fullText.length)); // adaptive speed

    intervalRef.current = setInterval(() => {
      idx += 2; // Stream 2 chars at a time for natural feel
      if (idx >= fullText.length) {
        setDisplayedText(fullText);
        setIsStreaming(false);
        if (intervalRef.current) clearInterval(intervalRef.current);
        return;
      }
      setDisplayedText(fullText.slice(0, idx));
    }, speed);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [data.thinking]);

  // Auto-expand briefly when streaming starts, then collapse
  useEffect(() => {
    setIsExpanded(true);
    const timer = setTimeout(() => {
      if (!isStreaming) setIsExpanded(false);
    }, 4000);
    return () => clearTimeout(timer);
  }, []);

  // When streaming ends, auto-collapse after a short delay
  useEffect(() => {
    if (!isStreaming) {
      const timer = setTimeout(() => setIsExpanded(false), 1500);
      return () => clearTimeout(timer);
    }
  }, [isStreaming]);

  const durationSec = (data.duration_ms / 1000).toFixed(1);

  return (
    <div className="flex justify-start px-4 py-1.5">
      <div className="max-w-[85%] sm:max-w-[75%] w-full">
        <div aria-live="polite" aria-atomic="true" className="sr-only">
          {isStreaming ? "Thinking…" : `Thought for ${durationSec} seconds`}
        </div>
        {/* Thinking header — always visible */}
        <button
          onClick={() => setIsExpanded((prev) => !prev)}
          className="flex items-center gap-2 text-xs font-medium text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] transition-colors group w-full text-left"
          aria-expanded={isExpanded}
        >
          {/* Animated thinking indicator */}
          <span className="relative flex h-4 w-4 items-center justify-center">
            {isStreaming ? (
              <>
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent/40" />
                <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-accent" />
              </>
            ) : (
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="text-accent"
              >
                <circle cx="12" cy="12" r="10" />
                <path d="M12 16v-4M12 8h.01" />
              </svg>
            )}
          </span>

          <span>
            {isStreaming ? "Thinking…" : `Thought for ${durationSec}s`}
          </span>

          {/* Expand/collapse chevron */}
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={`transition-transform duration-200 ${isExpanded ? "rotate-180" : ""}`}
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>

        {/* Collapsible content */}
        <div
          className={`transition-all duration-300 ease-in-out ${
            isExpanded ? "max-h-[60vh] opacity-100 mt-2" : "max-h-0 opacity-0 overflow-hidden"
          }`}
        >
          <div className="rounded-xl border border-[var(--border-light)] bg-[var(--panel-bg)]/60 backdrop-blur-sm px-4 py-3 text-[13px] leading-relaxed text-[var(--text-secondary)] max-h-[55vh] overflow-y-auto">
            {/* Main thinking text with streaming cursor */}
            <div className="whitespace-pre-wrap">
              {displayedText || data.thinking}
              {isStreaming && (
                <span className="inline-block w-0.5 h-4 bg-accent ml-0.5 animate-pulse align-text-bottom" />
              )}
            </div>

            {/* Structured insights — shown after streaming completes */}
            {!isStreaming && (
              <div className="mt-3 pt-3 border-t border-[var(--border-light)] space-y-2">
                {data.intent && (
                  <div>
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-accent">
                      Intent
                    </span>
                    <p className="text-[12px] text-[var(--text-secondary)] mt-0.5">{data.intent}</p>
                  </div>
                )}

                {data.assumptions.length > 0 && (
                  <div>
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">
                      Assumptions
                    </span>
                    <ul className="text-[12px] text-[var(--text-secondary)] mt-0.5 space-y-0.5">
                      {data.assumptions.map((a, i) => (
                        <li key={i} className="flex items-start gap-1.5">
                          <span className="text-accent mt-0.5 shrink-0">•</span>
                          <span>{a}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {data.second_order_effects.length > 0 && (
                  <div>
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">
                      Second-order effects
                    </span>
                    <ul className="text-[12px] text-[var(--text-secondary)] mt-0.5 space-y-0.5">
                      {data.second_order_effects.map((e, i) => (
                        <li key={i} className="flex items-start gap-1.5">
                          <span className="text-amber-500 mt-0.5 shrink-0">→</span>
                          <span>{e}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
