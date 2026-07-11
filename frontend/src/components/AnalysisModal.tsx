"use client";

import { type ReactNode, useEffect, useRef, useId } from "react";

interface AnalysisModalProps {
  children: ReactNode;
  onCollapse: () => void; // Minimize back to card (backdrop/Escape)
  /** Optional visible title used for aria-labelledby; falls back to aria-label */
  title?: string;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Overlay modal for expanded analysis panels.
 * - Renders within the main content area (position: absolute)
 * - Backdrop click or Escape key collapses back to card strip
 * - Panel's own PanelHeader close button removes the card entirely
 * - Focus is trapped inside while open; restored on unmount
 */
export function AnalysisModal({ children, onCollapse, title }: AnalysisModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const titleId = useId();

  useEffect(() => {
    previouslyFocused.current = document.activeElement as HTMLElement | null;

    const dialog = dialogRef.current;
    if (dialog) {
      const focusables = dialog.querySelectorAll<HTMLElement>(FOCUSABLE);
      const first = focusables[0];
      if (first) {
        first.focus();
      } else {
        dialog.focus();
      }
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCollapse();
        return;
      }

      if (e.key !== "Tab" || !dialogRef.current) return;

      const focusables = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)
      ).filter((el) => !el.hasAttribute("disabled") && el.tabIndex !== -1);

      if (focusables.length === 0) {
        e.preventDefault();
        dialogRef.current.focus();
        return;
      }

      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;

      if (e.shiftKey) {
        if (active === first || !dialogRef.current.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      previouslyFocused.current?.focus?.();
    };
  }, [onCollapse]);

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/20 backdrop-blur-[2px] transition-opacity"
        onClick={onCollapse}
        aria-hidden="true"
      />
      {/* Content card */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        {...(title
          ? { "aria-labelledby": titleId }
          : { "aria-label": "Analysis panel" })}
        tabIndex={-1}
        className="relative z-10 w-full max-w-5xl max-h-[88vh] rounded-2xl shadow-2xl border border-[var(--border)] bg-background overflow-auto outline-none"
        style={{ animation: "modalIn 150ms ease-out" }}
      >
        {title ? (
          <h2 id={titleId} className="sr-only">
            {title}
          </h2>
        ) : null}
        {children}
      </div>

      {/* Keyframe animation (injected once) */}
      <style>{`
        @keyframes modalIn {
          from { opacity: 0; transform: scale(0.97) translateY(8px); }
          to   { opacity: 1; transform: scale(1)    translateY(0); }
        }
      `}</style>
    </div>
  );
}
