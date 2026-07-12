"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { Conversation } from "@/types/chat";
import { ThemeToggle } from "./ThemeToggle";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";
import { strings } from "@/lib/strings";
import { usePlanningConnectorsEnabled } from "@/lib/features";

interface SidebarProps {
  conversations: Conversation[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  /** Mobile drawer open state (below md) */
  mobileOpen?: boolean;
  onMobileClose?: () => void;
}

function formatDate(d: Date) {
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  if (diff < 60_000) return "Just now";
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  return d.toLocaleDateString();
}

function ConversationRow({
  conversation: c,
  active,
  onSelect,
  onRename,
  onDelete,
}: {
  conversation: Conversation;
  active: boolean;
  onSelect: () => void;
  onRename: (title: string) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(c.title);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      setDraft(c.title);
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing, c.title]);

  const commitRename = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== c.title) onRename(trimmed);
    setEditing(false);
  };

  const handleDelete = () => {
    if (window.confirm(strings.sidebar.deleteConfirm)) onDelete();
  };

  return (
    <li className="group relative">
      {editing ? (
        <div className="px-2 py-1.5">
          <input
            ref={inputRef}
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitRename();
              } else if (e.key === "Escape") {
                setEditing(false);
              }
            }}
            className="w-full rounded-lg border border-accent/40 bg-[var(--card-bg)] px-2.5 py-1.5 text-sm text-[var(--sidebar-text)] outline-none focus:ring-1 focus:ring-accent/40"
            aria-label={strings.sidebar.rename}
          />
        </div>
      ) : (
        <div
          className={`flex items-center rounded-xl transition-all ${
            active
              ? "bg-[var(--sidebar-active)] border-l-2 border-accent"
              : "hover:bg-[var(--sidebar-hover)]"
          }`}
        >
          <button
            type="button"
            onClick={onSelect}
            className={`flex-1 min-w-0 text-left px-3 py-2.5 text-sm truncate ${
              active
                ? "text-[var(--sidebar-text)] font-medium"
                : "text-[var(--sidebar-text-muted)] hover:text-[var(--sidebar-text)]"
            }`}
          >
            <span className="block truncate">{c.title || strings.sidebar.untitled}</span>
            <span className="block text-[10px] opacity-60 mt-0.5">
              {formatDate(c.updatedAt)}
            </span>
          </button>
          <div className="flex items-center gap-0.5 pr-1.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity shrink-0">
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="p-1.5 rounded-md text-[var(--sidebar-text-muted)] hover:text-[var(--sidebar-text)] hover:bg-[var(--sidebar-hover)]"
              aria-label={strings.sidebar.rename}
              title={strings.sidebar.rename}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 20h9" />
                <path d="M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4L16.5 3.5z" />
              </svg>
            </button>
            <button
              type="button"
              onClick={handleDelete}
              className="p-1.5 rounded-md text-[var(--sidebar-text-muted)] hover:text-[var(--danger)] hover:bg-[var(--danger-bg)]"
              aria-label={strings.sidebar.delete}
              title={strings.sidebar.delete}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
              </svg>
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

function SidebarContent({
  conversations,
  activeId,
  onSelect,
  onNewChat,
  onRename,
  onDelete,
  collapsed,
  setCollapsed,
  showCollapse,
}: {
  conversations: Conversation[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  collapsed: boolean;
  setCollapsed: (v: boolean) => void;
  showCollapse: boolean;
}) {
  const [query, setQuery] = useState("");
  const planningConnectorsEnabled = usePlanningConnectorsEnabled();

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return conversations;
    return conversations.filter((c) =>
      (c.title || "").toLowerCase().includes(q)
    );
  }, [conversations, query]);

  if (collapsed) {
    return (
      <div className="w-14 flex-shrink-0 flex flex-col items-center py-3 h-full border-r border-[var(--sidebar-border)] bg-[var(--sidebar-bg)]">
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          className="p-2 rounded-lg hover:bg-[var(--sidebar-hover)] text-[var(--sidebar-text)] transition-colors"
          aria-label={strings.sidebar.expand}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M9 18l6-6-6-6" />
          </svg>
        </button>
        <button
          type="button"
          onClick={onNewChat}
          className="mt-4 p-2 rounded-lg hover:bg-[var(--sidebar-hover)] text-[var(--sidebar-text)] transition-colors"
          aria-label={strings.sidebar.newChat}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
        {planningConnectorsEnabled && (
          <Link
            href="/connections"
            className="mt-2 p-2 rounded-lg hover:bg-[var(--sidebar-hover)] text-[var(--sidebar-text)] transition-colors"
            aria-label="Data & Models"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <ellipse cx="12" cy="5" rx="9" ry="3" />
              <path d="M3 5v6c0 1.7 4 3 9 3s9-1.3 9-3V5" />
              <path d="M3 11v6c0 1.7 4 3 9 3s9-1.3 9-3v-6" />
            </svg>
          </Link>
        )}
      </div>
    );
  }

  return (
    <div className="w-64 flex-shrink-0 flex flex-col h-full border-r border-[var(--sidebar-border)] bg-[var(--sidebar-bg)]">
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
            <span className="block text-[10px] text-[var(--sidebar-text-muted)] leading-none mt-0.5">{strings.sidebar.brand}</span>
          </div>
        </div>
        {showCollapse && (
          <button
            type="button"
            onClick={() => setCollapsed(true)}
            className="p-1.5 rounded-lg hover:bg-[var(--sidebar-hover)] text-[var(--sidebar-text-muted)] transition-colors"
            aria-label={strings.sidebar.collapse}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M15 18l-6-6 6-6" />
            </svg>
          </button>
        )}
      </div>

      {/* Workspace selector — isolated documents/model/scenarios per workspace */}
      <WorkspaceSwitcher />

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
        {strings.sidebar.newChat}
      </button>

      {/* Data & Models hub — planning connectors */}
      {planningConnectorsEnabled && (
        <Link
          href="/connections"
          className="mx-3 mb-2 flex items-center gap-2 rounded-xl border border-[var(--sidebar-border)] px-3 py-2 text-sm font-medium text-[var(--sidebar-text)] hover:bg-[var(--sidebar-hover)] transition-colors"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <ellipse cx="12" cy="5" rx="9" ry="3" />
            <path d="M3 5v6c0 1.7 4 3 9 3s9-1.3 9-3V5" />
            <path d="M3 11v6c0 1.7 4 3 9 3s9-1.3 9-3v-6" />
          </svg>
          Data &amp; Models
        </Link>
      )}

      {/* Search filter */}
      <div className="px-3 pb-2">
        <label className="sr-only" htmlFor="sidebar-search">
          {strings.sidebar.searchLabel}
        </label>
        <div className="relative">
          <svg
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--sidebar-text-muted)] pointer-events-none"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            id="sidebar-search"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={strings.sidebar.search}
            className="w-full rounded-lg border border-[var(--sidebar-border)] bg-[var(--card-bg)]/50 pl-8 pr-3 py-1.5 text-sm text-[var(--sidebar-text)] placeholder:text-[var(--sidebar-text-muted)] outline-none focus:border-accent/40 focus:ring-1 focus:ring-accent/20"
          />
        </div>
      </div>

      {/* Conversation list */}
      <nav className="flex-1 overflow-y-auto chat-scroll px-2 pb-4" aria-label="Conversations">
        {conversations.length === 0 ? (
          <p className="px-3 py-4 text-xs text-[var(--sidebar-text-muted)] text-center">
            {strings.sidebar.empty}
            <br />
            <span className="text-[var(--sidebar-text-muted)] opacity-70">{strings.sidebar.emptyHint}</span>
          </p>
        ) : filtered.length === 0 ? (
          <p className="px-3 py-4 text-xs text-[var(--sidebar-text-muted)] text-center">
            {strings.sidebar.noResults}
          </p>
        ) : (
          <ul className="space-y-0.5">
            {filtered.map((c) => (
              <ConversationRow
                key={c.id}
                conversation={c}
                active={activeId === c.id}
                onSelect={() => onSelect(c.id)}
                onRename={(title) => onRename(c.id, title)}
                onDelete={() => onDelete(c.id)}
              />
            ))}
          </ul>
        )}
      </nav>

      {/* Footer with branding */}
      <div className="p-3 border-t border-[var(--sidebar-border)] flex items-center justify-between">
        <p className="text-[10px] text-[var(--sidebar-text-muted)] opacity-50">
          {strings.sidebar.footer}
        </p>
        <ThemeToggle />
      </div>
    </div>
  );
}

export function Sidebar({
  conversations,
  activeId,
  onSelect,
  onNewChat,
  onRename,
  onDelete,
  mobileOpen = false,
  onMobileClose,
}: SidebarProps) {
  const [collapsed, setCollapsed] = useState(false);

  const selectAndClose = (id: string) => {
    onSelect(id);
    onMobileClose?.();
  };

  const newChatAndClose = () => {
    onNewChat();
    onMobileClose?.();
  };

  return (
    <>
      {/* Desktop: fixed sidebar */}
      <aside className="hidden md:flex flex-shrink-0 h-full">
        <SidebarContent
          conversations={conversations}
          activeId={activeId}
          onSelect={onSelect}
          onNewChat={onNewChat}
          onRename={onRename}
          onDelete={onDelete}
          collapsed={collapsed}
          setCollapsed={setCollapsed}
          showCollapse
        />
      </aside>

      {/* Mobile: overlay drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 md:hidden" role="dialog" aria-modal="true" aria-label="Sidebar">
          <button
            type="button"
            className="absolute inset-0 bg-black/40"
            aria-label={strings.sidebar.closeMenu}
            onClick={onMobileClose}
          />
          <aside className="absolute inset-y-0 left-0 z-10 shadow-panel-lg">
            <SidebarContent
              conversations={conversations}
              activeId={activeId}
              onSelect={selectAndClose}
              onNewChat={newChatAndClose}
              onRename={onRename}
              onDelete={onDelete}
              collapsed={false}
              setCollapsed={() => {}}
              showCollapse={false}
            />
          </aside>
        </div>
      )}
    </>
  );
}
