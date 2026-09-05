"use client";

import { ChatContainer } from "./ChatContainer";

/** Thin wrapper so existing `page.tsx` imports keep working. */
export function ChatWindow() {
  return <ChatContainer />;
}
