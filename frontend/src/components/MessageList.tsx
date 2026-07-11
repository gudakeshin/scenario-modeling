"use client";

import { useEffect, useRef } from "react";
import { MessageBubble } from "./MessageBubble";
import type { Message } from "@/types/chat";

interface MessageListProps {
  messages: Message[];
  isLoading?: boolean;
}

export function MessageList({ messages, isLoading }: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  return (
    <div className="chat-scroll flex-1 overflow-y-auto bg-background">
      <div className="mx-auto max-w-3xl pb-4">
        {messages.length === 0 && !isLoading && (
          <div className="px-4 pt-16 text-center">
            {/* Deloitte branded hero */}
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl deloitte-gradient shadow-panel-lg mb-5">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
                <path d="M3 3h18v18H3V3z" />
                <path d="M3 9h18M9 3v18" />
              </svg>
            </div>
            <p className="text-xl font-semibold text-[var(--text-primary)] mb-2">Scenario Modeling</p>
            <p className="text-sm text-[var(--text-secondary)] max-w-md mx-auto leading-relaxed">
              Describe a scenario in plain English and get P&amp;L impact in minutes. Try
              something like:
            </p>
            <div className="mt-4 inline-block rounded-xl bg-[var(--panel-bg)] border border-[var(--panel-border)] px-4 py-3 text-sm text-[var(--text-secondary)] italic shadow-card">
              &quot;What if we delay the APAC launch by one quarter and raw materials increase 8%?&quot;
            </div>
          </div>
        )}
        {messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} />
        ))}
        <div aria-live="polite" aria-atomic="true" className="contents">
          {isLoading && (
            <div className="flex justify-start px-4 py-2" role="status">
              <span className="sr-only">Assistant is thinking</span>
              <div className="rounded-2xl bg-[var(--message-assistant-bg)] border border-[var(--border-light)] px-4 py-3 flex gap-1.5 shadow-card" aria-hidden="true">
                <span className="w-2 h-2 rounded-full bg-accent animate-bounce [animation-delay:-0.3s]" />
                <span className="w-2 h-2 rounded-full bg-accent/70 animate-bounce [animation-delay:-0.15s]" />
                <span className="w-2 h-2 rounded-full bg-accent/40 animate-bounce" />
              </div>
            </div>
          )}
        </div>
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
