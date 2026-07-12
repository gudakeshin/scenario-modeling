"use client";

import { useChatStore, type AssistantMode } from "@/stores/chatStore";
import { strings } from "@/lib/strings";

interface ChatAssistantModeToggleProps {
  disabled?: boolean;
}

/**
 * Mode toggle for the unified assistant surface.
 * Scenario mode keeps the approval gate; Documents mode uses auth'd RAG APIs.
 */
export function ChatAssistantModeToggle({ disabled }: ChatAssistantModeToggleProps) {
  const assistantMode = useChatStore((s) => s.assistantMode);
  const setAssistantMode = useChatStore((s) => s.setAssistantMode);

  const setMode = (mode: AssistantMode) => {
    if (disabled) return;
    setAssistantMode(mode);
  };

  const btn = (mode: AssistantMode, label: string) => {
    const active = assistantMode === mode;
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={() => setMode(mode)}
        aria-pressed={active}
        className={`rounded-lg px-3 py-1 text-xs font-medium transition-all disabled:opacity-40 ${
          active
            ? "bg-accent/15 text-accent border border-accent/30"
            : "text-[var(--text-secondary)] border border-transparent hover:bg-[var(--panel-bg)]"
        }`}
      >
        {label}
      </button>
    );
  };

  return (
    <div
      className="flex items-center gap-1 rounded-xl border border-[var(--border)] bg-[var(--input-bg)] p-0.5"
      role="group"
      aria-label="Assistant mode"
    >
      {btn("scenario", strings.chat.modeScenario)}
      {btn("documents", strings.chat.modeDocuments)}
    </div>
  );
}
