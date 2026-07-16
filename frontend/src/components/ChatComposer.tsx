"use client";

import { useRef, useState, useCallback } from "react";
import { ChatAssistantModeToggle } from "./ChatAssistant";

interface ChatComposerProps {
  onSend: (text: string) => void;
  disabled?: boolean;
  placeholder?: string;
  /** Show Scenario / Documents mode toggle above the input. */
  showModeToggle?: boolean;
}

export function ChatComposer({
  onSend,
  disabled = false,
  placeholder = "Describe your scenario in plain English\u2026",
  showModeToggle = true,
}: ChatComposerProps) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSubmit = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setValue("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [value, disabled, onSend]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setValue(e.target.value);
    const el = e.target;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  };

  return (
    <div className="border-t border-[var(--border)] bg-background px-4 py-3 shrink-0">
      {showModeToggle && (
        <div className="mx-auto max-w-3xl mb-2 flex items-center justify-between gap-2">
          <ChatAssistantModeToggle disabled={disabled} />
          <p className="text-[11px] text-[var(--text-faint)] hidden sm:block">
            Documents answers from uploads · Scenarios still require Approve &amp; Run
          </p>
        </div>
      )}
      <div className="mx-auto max-w-3xl flex gap-2 items-end rounded-2xl bg-[var(--input-bg)] border border-[var(--input-border)] focus-within:ring-2 focus-within:ring-accent/20 focus-within:border-[var(--input-focus-border)] transition-all shadow-card">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          rows={1}
          className="flex-1 resize-none bg-transparent px-4 py-3 text-[var(--text-primary)] placeholder:text-[var(--text-faint)] focus:outline-none min-h-[52px] max-h-[200px] text-[15px] leading-relaxed"
          aria-label="Message"
        />
        <button
          type="button"
          onClick={handleSubmit}
          disabled={disabled || !value.trim()}
          className="mb-2 mr-2 rounded-xl bg-accent text-white px-4 py-2 text-sm font-medium hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors focus:outline-none focus:ring-2 focus:ring-accent/30 focus:ring-offset-2 focus:ring-offset-background shadow-sm"
        >
          Send
        </button>
      </div>
      <p className="text-center text-xs text-[var(--text-faint)] mt-2">
        Enter to send, Shift+Enter for new line
      </p>
    </div>
  );
}
