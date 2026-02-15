/**
 * Shared LLM Client — wraps the Anthropic Claude API.
 *
 * All LLM calls go through this module so the model provider
 * is configured in one place.
 */

import Anthropic from "@anthropic-ai/sdk";

let _client: Anthropic | null = null;
let _cachedKey: string | null = null;

/** Default model: Claude Haiku 4.5 (fast + cheap) */
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

export function getApiKey(): string | undefined {
  return process.env.ANTHROPIC_API_KEY;
}

export function getModel(): string {
  return process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;
}

export function getClient(): Anthropic {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");
  // Recreate client if key changed (e.g., in tests)
  if (!_client || _cachedKey !== apiKey) {
    _client = new Anthropic({ apiKey });
    _cachedKey = apiKey;
  }
  return _client;
}

/**
 * Call Claude and return the text content.
 * Throws on failure — callers should catch and fall back.
 */
export async function callClaude(opts: {
  system: string;
  userMessage: string;
  maxTokens?: number;
  temperature?: number;
}): Promise<string> {
  const client = getClient();
  const response = await client.messages.create({
    model: getModel(),
    max_tokens: opts.maxTokens ?? 2000,
    temperature: opts.temperature ?? 0.2,
    system: opts.system,
    messages: [{ role: "user", content: opts.userMessage }],
  });

  const block = response.content[0];
  if (block.type !== "text" || !block.text) {
    throw new Error("Empty Claude response");
  }
  return block.text.trim();
}
