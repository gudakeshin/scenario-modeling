"use client";

import type { Message } from "@/types/chat";
import { ThinkingBlock } from "./ThinkingBlock";
import { AgentTracePanel } from "./AgentTracePanel";
import { MarkdownContent } from "./MarkdownContent";

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
      {!isUser &&
      (message.causalChain?.length ||
        message.agentTrace?.length ||
        message.previewPl ||
        message.agentCitations?.length ||
        message.constraintViolations?.length ||
        message.agentConfidence != null) ? (
        <AgentTracePanel
          causalChain={message.causalChain}
          agentTrace={message.agentTrace}
          confidence={message.agentConfidence}
          citations={message.agentCitations}
          previewPl={message.previewPl}
          previewReconciliation={message.previewReconciliation}
          constraintViolations={message.constraintViolations}
        />
      ) : null}
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
          {isUser ? (
            <p className="text-[15px] leading-relaxed whitespace-pre-wrap break-words">
              {message.content}
            </p>
          ) : (
            <MarkdownContent content={message.content} className="text-[15px]" />
          )}
        </div>
      </div>
    </>
  );
}
