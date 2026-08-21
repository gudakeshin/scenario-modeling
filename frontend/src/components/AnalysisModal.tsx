"use client";

import { type ReactNode, useEffect, useRef, useId } from "react";
import { createPortal } from "react-dom";

interface AnalysisModalProps {
  children: ReactNode;
  onCollapse: () => void; // Minimize back to card (backdrop/Escape)
  /** Optional visible title used for aria-labelledby; falls back to aria-label */
  title?: string;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The app shell, made inert while the modal is open. */
export const APP_SHELL_ID = "app-shell";

/**
 * Overlay modal for expanded analysis panels.
 * - Portals to <body> and covers the whole viewport, so `aria-modal` is honest:
 *   the shell behind it is marked `inert` and cannot be clicked or tabbed into.
 * - Backdrop click or Escape key collapses back to the card strip
 * - Panel's own PanelHeader close button removes the card entirely
 * - Focus is trapped inside while open; restored on close
 */
export function AnalysisModal({ children, onCollapse, title }: AnalysisModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const titleId = useId();

  // Held in a ref so the setup effect below depends on nothing that changes
  // per render. Callers pass inline arrows; without this the effect would tear
  // down and re-run constantly, yanking focus back to the first control.
  const onCollapseRef = useRef(onCollapse);
  onCollapseRef.current = onCollapse;

  useEffect(() => {
    previouslyFocused.current = document.activeElement as HTMLElement | null;

    const shell = document.getElementById(APP_SHELL_ID);
    shell?.setAttribute("inert", "");

    const dialog = dialogRef.current;
    if (dialog) {
      const focusables = dialog.querySelectorAll<HTMLElement>(FOCUSABLE);
      const first = focusables[0];
      if (first) {
        first.focus({ preventScroll: true });
      } else {
        dialog.focus({ preventScroll: true });
      }
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCollapseRef.current();
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
      // Always clear inert, including on an unexpected unmount, or the app
      // would be left permanently unfocusable.
      shell?.removeAttribute("inert");
      previouslyFocused.current?.focus?.();
    };
  }, []);

  const content = (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/20 backdrop-blur-[2px] transition-opacity"
        onClick={() => onCollapseRef.current()}
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
        className="analysis-modal-card relative z-10 w-full max-w-5xl max-h-[88vh] rounded-2xl shadow-2xl border border-[var(--border)] bg-background overflow-auto outline-none"
      >
        {title ? (
          <h2 id={titleId} className="sr-only">
            {title}
          </h2>
        ) : null}
        {children}
      </div>
    </div>
  );

  // Portal so the dialog escapes the message-stage stacking context and can
  // genuinely cover the sidebar, action bar and composer.
  return typeof document === "undefined" ? content : createPortal(content, document.body);
}
