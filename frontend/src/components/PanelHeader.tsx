"use client";

import { type ReactNode } from "react";

interface PanelHeaderProps {
  title: string | ReactNode;
  icon: ReactNode;
  onClose: () => void;
  onMinimize: () => void;
  isMinimized: boolean;
  /** Optional extra controls (buttons) between title and close/minimize */
  actions?: ReactNode;
}

/**
 * Shared header for all panel windows — provides minimize + close controls.
 */
export function PanelHeader({ title, icon, onClose, onMinimize, isMinimized, actions }: PanelHeaderProps) {
  // Icon-only controls need a real name. `title` alone is a weak accname and
  // was identical ("Close") across every panel.
  const name = typeof title === "string" ? title : "panel";
  return (
    <div className="flex items-center justify-between mb-3">
      <div className="flex items-center gap-2 min-w-0">
        {icon}
        <h3 className="text-sm font-semibold text-[var(--text-primary)] truncate">{title}</h3>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        {!isMinimized && actions}
        {/* Minimize button */}
        <button
          type="button"
          onClick={onMinimize}
          className="w-6 h-6 rounded-md flex items-center justify-center text-[var(--text-faint)] hover:text-[var(--text-primary)] hover:bg-[var(--panel-bg)] transition-colors"
          title={isMinimized ? "Expand" : "Minimize"}
          aria-label={`${isMinimized ? "Expand" : "Minimize"} ${name}`}
        >
          {isMinimized ? (
            /* Expand icon (chevron up / maximize) */
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="17 11 12 6 7 11" />
              <polyline points="17 18 12 13 7 18" />
            </svg>
          ) : (
            /* Minimize icon (horizontal line) */
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          )}
        </button>
        {/* Close button */}
        <button
          type="button"
          onClick={onClose}
          className="w-6 h-6 rounded-md flex items-center justify-center text-[var(--text-faint)] hover:text-[var(--danger)] hover:bg-[var(--danger-bg)] transition-colors"
          title="Close"
          aria-label={`Close ${name}`}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
    </div>
  );
}
