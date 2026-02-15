export type MessageRole = "user" | "assistant";

export interface ThinkingData {
  /** The LLM's reasoning / chain-of-thought */
  thinking: string;
  /** One-sentence intent summary */
  intent: string;
  /** Assumptions made during analysis */
  assumptions: string[];
  /** Second-order effects identified */
  second_order_effects: string[];
  /** How long the reflection took (ms) */
  duration_ms: number;
}

export interface Message {
  id: string;
  role: MessageRole;
  content: string;
  timestamp: Date;
  /** Optional: visible thinking/reasoning from the LLM reflection loop */
  thinking?: ThinkingData;
}

export interface Conversation {
  id: string;
  title: string;
  messages: Message[];
  updatedAt: Date;
  scenarioId?: string | null;
}
