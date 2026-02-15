"use client";

import { type ReactNode, useEffect } from "react";

interface AnalysisModalProps {
  children: ReactNode;
  onCollapse: () => void; // Minimize back to card (backdrop/Escape)
}

/**
 * Overlay modal for expanded analysis panels.
 * - Renders within the main content area (position: absolute)
 * - Backdrop click or Escape key collapses back to card strip
 * - Panel's own PanelHeader close button removes the card entirely
 */
export function AnalysisModal({ children, onCollapse }: AnalysisModalProps) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCollapse();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onCollapse]);

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/20 backdrop-blur-[2px] transition-opacity"
        onClick={onCollapse}
      />
      {/* Content card */}
      <div
        className="relative z-10 w-full max-w-5xl max-h-[88vh] rounded-2xl shadow-2xl border border-[var(--border)] bg-background overflow-auto"
        style={{ animation: "modalIn 150ms ease-out" }}
      >
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
