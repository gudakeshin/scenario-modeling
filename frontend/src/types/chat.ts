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

export interface CausalChainStep {
  step: string;
  detail?: string;
  kind?: "decomposition" | "research" | "levers" | "preview" | "other";
}

export interface AgentTraceStep {
  tool: string;
  input: unknown;
  output: unknown;
}

export interface Message {
  id: string;
  role: MessageRole;
  content: string;
  timestamp: Date;
  /** Optional: visible thinking/reasoning from the LLM reflection loop */
  thinking?: ThinkingData;
  /** Optional: agentic causal chain + tool trace */
  agentTrace?: AgentTraceStep[];
  causalChain?: CausalChainStep[];
  agentConfidence?: number;
  agentCitations?: Array<{ source: string; snippet?: string; url?: string }>;
  previewPl?: Record<string, number>;
  previewReconciliation?: {
    reconciled: boolean;
    max_abs_diff: number;
    message?: string;
  };
  constraintViolations?: Array<{ lever: string; reason: string }>;
}

export interface Conversation {
  id: string;
  title: string;
  messages: Message[];
  updatedAt: Date;
  scenarioId?: string | null;
  /** Persisted conversational session for follow-ups; restored on select */
  sessionId?: string | null;
}
