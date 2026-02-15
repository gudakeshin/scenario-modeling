"use client";

import { useState } from "react";
import type { Conversation } from "@/types/chat";

interface SidebarProps {
  conversations: Conversation[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNewChat: () => void;
}

function formatDate(d: Date) {
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  if (diff < 60_000) return "Just now";
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  return d.toLocaleDateString();
}

export function Sidebar({
  conversations,
  activeId,
  onSelect,
  onNewChat,
}: SidebarProps) {
  const [collapsed, setCollapsed] = useState(false);

  if (collapsed) {
    return (
      <aside className="w-14 flex-shrink-0 flex flex-col items-center py-3 border-r border-[var(--sidebar-border)] bg-[var(--sidebar-bg)]">
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          className="p-2 rounded-lg hover:bg-[var(--sidebar-hover)] text-[var(--sidebar-text)] transition-colors"
          aria-label="Expand sidebar"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M9 18l6-6-6-6" />
          </svg>
        </button>
        <button
          type="button"
          onClick={onNewChat}
          className="mt-4 p-2 rounded-lg hover:bg-[var(--sidebar-hover)] text-[var(--sidebar-text)] transition-colors"
          aria-label="New scenario"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
      </aside>
    );
  }

  return (
    <aside className="w-64 flex-shrink-0 flex flex-col border-r border-[var(--sidebar-border)] bg-[var(--sidebar-bg)]">
      {/* Header with Deloitte branding */}
      <div className="p-4 flex items-center justify-between border-b border-[var(--sidebar-border)]">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-lg deloitte-gradient flex items-center justify-center shadow-sm">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5">
              <path d="M3 3h18v18H3V3z" />
              <path d="M3 9h18M9 3v18" />
            </svg>
          </div>
          <div>
            <span className="font-semibold text-[var(--sidebar-text)] text-sm tracking-tight">Scenarios</span>
            <span className="block text-[10px] text-[var(--sidebar-text-muted)] leading-none mt-0.5">Deloitte</span>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setCollapsed(true)}
          className="p-1.5 rounded-lg hover:bg-[var(--sidebar-hover)] text-[var(--sidebar-text-muted)] transition-colors"
          aria-label="Collapse sidebar"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
      </div>

      {/* New scenario button */}
      <button
        type="button"
        onClick={onNewChat}
        className="m-3 flex items-center gap-2 rounded-xl bg-accent hover:bg-accent-hover px-3 py-2.5 text-sm font-medium text-white transition-colors shadow-sm"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
        New scenario
      </button>

      {/* Conversation list */}
      <nav className="flex-1 overflow-y-auto chat-scroll px-2 pb-4">
        {conversations.length === 0 ? (
          <p className="px-3 py-4 text-xs text-[var(--sidebar-text-muted)] text-center">
            No scenarios yet.
            <br />
            <span className="text-[var(--sidebar-text-muted)] opacity-70">Start by describing a scenario above.</span>
          </p>
        ) : (
          <ul className="space-y-0.5">
            {conversations.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => onSelect(c.id)}
                  className={`w-full text-left rounded-xl px-3 py-2.5 text-sm truncate transition-all ${
                    activeId === c.id
                      ? "bg-[var(--sidebar-active)] text-[var(--sidebar-text)] font-medium border-l-2 border-accent"
                      : "text-[var(--sidebar-text-muted)] hover:bg-[var(--sidebar-hover)] hover:text-[var(--sidebar-text)]"
                  }`}
                >
                  <span className="block truncate">{c.title || "Untitled"}</span>
                  <span className="block text-[10px] opacity-60 mt-0.5">
                    {formatDate(c.updatedAt)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </nav>

      {/* Footer with branding */}
      <div className="p-3 border-t border-[var(--sidebar-border)]">
        <p className="text-[10px] text-[var(--sidebar-text-muted)] text-center opacity-50">
          Scenario Modeling Platform
        </p>
      </div>
    </aside>
  );
}
