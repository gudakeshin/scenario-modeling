"use client";

import type { Message } from "@/types/chat";
import { ThinkingBlock } from "./ThinkingBlock";

interface MessageBubbleProps {
  message: Message;
}

export function MessageBubble({ message }: MessageBubbleProps) {
  const isUser = message.role === "user";

  return (
    <>
      {/* Thinking block appears above the assistant message */}
      {!isUser && message.thinking && (
        <ThinkingBlock data={message.thinking} />
      )}
      <div
        className={`flex w-full ${isUser ? "justify-end" : "justify-start"} px-4 py-2`}
      >
        <div
          className={`max-w-[85%] sm:max-w-[75%] rounded-2xl px-4 py-3 shadow-card ${
            isUser
              ? "bg-[var(--message-user-bg)] text-[var(--message-user-text)]"
              : "bg-[var(--message-assistant-bg)] text-[var(--message-assistant-text)] border border-[var(--border-light)]"
          }`}
        >
          <p className="text-[15px] leading-relaxed whitespace-pre-wrap break-words">
            {message.content}
          </p>
        </div>
      </div>
    </>
  );
}
