"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PanelDef } from "@/lib/panels";

interface PanelMenuProps {
  label: string;
  items: PanelDef[];
  openPanels: readonly string[];
  isLoading: boolean;
  onToggle: (id: PanelDef["id"]) => void;
}

/**
 * One cluster of the action bar: a button that opens a menu of panel toggles.
 * Each item is a menuitemcheckbox so the open/closed state is announced without
 * the label having to change.
 */
export function PanelMenu({ label, items, openPanels, isLoading, onToggle }: PanelMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const activeCount = items.filter((i) => openPanels.includes(i.id)).length;

  const close = useCallback((refocus = false) => {
    setOpen(false);
    if (refocus) rootRef.current?.querySelector("button")?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close(true);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close]);

  // Move focus into the menu when it opens so keyboard users are not stranded.
  useEffect(() => {
    if (open) menuRef.current?.querySelector<HTMLElement>('[role="menuitemcheckbox"]')?.focus();
  }, [open]);

  const onMenuKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const nodes = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]') ?? [],
    );
    if (nodes.length === 0) return;
    const i = nodes.indexOf(document.activeElement as HTMLElement);
    const next = e.key === "ArrowDown" ? (i + 1) % nodes.length : (i - 1 + nodes.length) % nodes.length;
    nodes[next]?.focus();
  };

  if (items.length === 0) return null;

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`inline-flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-medium transition-all ${
          activeCount > 0
            ? "bg-accent/10 border-accent/30 text-accent shadow-sm"
            : "border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--panel-bg)] hover:border-[var(--panel-border)] hover:shadow-card"
        }`}
      >
        {label}
        {activeCount > 0 && (
          <span className="rounded-full bg-accent/20 px-1.5 text-[10px] font-semibold leading-4">
            {activeCount}
          </span>
        )}
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label={label}
          onKeyDown={onMenuKeyDown}
          className="absolute bottom-full left-0 mb-2 min-w-[13rem] rounded-xl border border-[var(--border)] bg-[var(--card-bg)] p-1 shadow-panel-lg z-30"
        >
          {items.map((item) => {
            const isOpen = openPanels.includes(item.id);
            return (
              <button
                key={item.id}
                type="button"
                role="menuitemcheckbox"
                aria-checked={isOpen}
                disabled={isLoading && item.disableWhileLoading}
                onClick={() => {
                  onToggle(item.id);
                  close(false);
                }}
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs text-[var(--text-primary)] hover:bg-[var(--panel-bg)] disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <span className={`w-2 h-2 rounded-full shrink-0 ${isOpen ? item.dot : "bg-transparent border border-[var(--border)]"}`} aria-hidden="true" />
                <span className="flex-1">{item.actionLabel}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
