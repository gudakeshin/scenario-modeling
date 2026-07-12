/**
 * Shared LLM Client — wraps the Anthropic Claude API.
 *
 * All LLM calls go through this module so retries, timeouts, model
 * routing, and usage tracking are handled in one place instead of being
 * (or not being) reimplemented per caller.
 */

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { pool } from "../db/index.js";
import { config } from "../config.js";
import { llmTokensUsed } from "../metrics.js";
import { logger } from "../logger.js";

let _client: Anthropic | null = null;
let _cachedKey: string | null = null;

const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
const REQUEST_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS) || 60_000;
const MAX_RETRIES = Number(process.env.LLM_MAX_RETRIES) || 3;

export type LlmPurpose = "parse" | "reflection" | "business_analysis" | "qa" | "context_build" | "narrative" | "rag" | "connector_map" | "other";

export function getApiKey(): string | undefined {
  return process.env.ANTHROPIC_API_KEY;
}

/** Legacy single-model getter (kept for narrativeService/ragService free-text calls). */
export function getModel(): string {
  return process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;
}

/** Model routing: parse gets the fast/cheap tier, analysis/QA get the stronger tier. */
function modelForPurpose(purpose: LlmPurpose): string {
  switch (purpose) {
    case "parse":
    case "reflection":
      return config.anthropicModelParse || getModel();
    case "business_analysis":
    case "qa":
    case "context_build":
      return config.anthropicModelAnalysis || getModel();
    default:
      return getModel();
  }
}

export function getClient(): Anthropic {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");
  if (!_client || _cachedKey !== apiKey) {
    _client = new Anthropic({ apiKey });
    _cachedKey = apiKey;
  }
  return _client;
}

async function logUsage(entry: {
  purpose: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  succeeded: boolean;
  errorMessage?: string;
}): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO llm_usage (purpose, model, input_tokens, output_tokens, latency_ms, succeeded, error_message)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [entry.purpose, entry.model, entry.inputTokens, entry.outputTokens, entry.latencyMs, entry.succeeded, entry.errorMessage ?? null],
    );
  } catch (e) {
    // Usage logging must never break the caller's actual LLM call.
    logger.warn({ detail: (e as Error).message }, "[llmClient] Failed to log usage:");
  }
  llmTokensUsed.inc({ model: entry.model, type: "input" }, entry.inputTokens);
  llmTokensUsed.inc({ model: entry.model, type: "output" }, entry.outputTokens);
}

/**
 * Call Claude and return the text content. Retries on transient errors
 * (429/5xx) via the SDK's built-in backoff; enforces a request timeout.
 * Throws on failure — callers should catch and fall back.
 */
export async function callClaude(opts: {
  system: string;
  userMessage: string;
  maxTokens?: number;
  temperature?: number;
  purpose?: LlmPurpose;
}): Promise<string> {
  const client = getClient();
  const model = modelForPurpose(opts.purpose ?? "other");
  const started = Date.now();
  try {
    const response = await client.messages.create(
      {
        model,
        max_tokens: opts.maxTokens ?? 2000,
        temperature: opts.temperature ?? 0.2,
        system: opts.system,
        messages: [{ role: "user", content: opts.userMessage }],
      },
      { maxRetries: MAX_RETRIES, timeout: REQUEST_TIMEOUT_MS },
    );

    const block = response.content[0];
    if (block.type !== "text" || !block.text) {
      throw new Error("Empty Claude response");
    }
    void logUsage({
      purpose: opts.purpose ?? "other",
      model,
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
      latencyMs: Date.now() - started,
      succeeded: true,
    });
    return block.text.trim();
  } catch (e) {
    void logUsage({
      purpose: opts.purpose ?? "other",
      model,
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: Date.now() - started,
      succeeded: false,
      errorMessage: (e as Error).message,
    });
    throw e;
  }
}

export class LlmSchemaError extends Error {
  constructor(message: string, public raw?: unknown) {
    super(message);
  }
}

/**
 * Call Claude and force it to return output matching `schema`, via a
 * forced tool-use call — no markdown fences, no truncation-repair
 * heuristics, no "hope the model followed the JSON instructions."
 * The SDK enforces syntactic JSON; `schema.parse` enforces the shape.
 */
export async function callClaudeStructured<T>(opts: {
  system: string;
  userMessage: string;
  // Pinning Def/Input to `any` forces TS to infer T from the Output slot
  // only — with a bare `z.ZodType<T>`, inference can otherwise pick up a
  // nested field's *input* type (pre-`.default()`), making every defaulted
  // property look optional/undefined to callers.
  schema: z.ZodType<T, z.ZodTypeDef, any>;
  toolName: string;
  toolDescription: string;
  maxTokens?: number;
  temperature?: number;
  purpose?: LlmPurpose;
}): Promise<T> {
  const client = getClient();
  const model = modelForPurpose(opts.purpose ?? "other");
  const jsonSchema = zodToJsonSchema(opts.schema, opts.toolName);
  const started = Date.now();

  try {
    const response = await client.messages.create(
      {
        model,
        max_tokens: opts.maxTokens ?? 2000,
        temperature: opts.temperature ?? 0.2,
        system: opts.system,
        messages: [{ role: "user", content: opts.userMessage }],
        tools: [
          {
            name: opts.toolName,
            description: opts.toolDescription,
            input_schema: (jsonSchema.definitions?.[opts.toolName] ?? jsonSchema) as Anthropic.Tool.InputSchema,
          },
        ],
        tool_choice: { type: "tool", name: opts.toolName },
      },
      { maxRetries: MAX_RETRIES, timeout: REQUEST_TIMEOUT_MS },
    );

    void logUsage({
      purpose: opts.purpose ?? "other",
      model,
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
      latencyMs: Date.now() - started,
      succeeded: true,
    });

    const toolUse = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (!toolUse) throw new LlmSchemaError("Model did not return a tool_use block");

    const parsed = opts.schema.safeParse(toolUse.input);
    if (!parsed.success) {
      throw new LlmSchemaError(`Structured output failed schema validation: ${parsed.error.message}`, toolUse.input);
    }
    return parsed.data;
  } catch (e) {
    if (!(e instanceof LlmSchemaError)) {
      void logUsage({
        purpose: opts.purpose ?? "other",
        model,
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: Date.now() - started,
        succeeded: false,
        errorMessage: (e as Error).message,
      });
    }
    throw e;
  }
}

export async function getUsageSummary(sinceHours = 24): Promise<{
  total_calls: number;
  total_input_tokens: number;
  total_output_tokens: number;
  failed_calls: number;
  by_purpose: Array<{ purpose: string; calls: number; input_tokens: number; output_tokens: number }>;
}> {
  const overall = await pool.query(
    `SELECT COUNT(*)::int AS total_calls,
            COALESCE(SUM(input_tokens),0)::int AS total_input_tokens,
            COALESCE(SUM(output_tokens),0)::int AS total_output_tokens,
            COUNT(*) FILTER (WHERE NOT succeeded)::int AS failed_calls
     FROM llm_usage WHERE created_at > NOW() - ($1 || ' hours')::interval`,
    [sinceHours],
  );
  const byPurpose = await pool.query(
    `SELECT purpose, COUNT(*)::int AS calls,
            COALESCE(SUM(input_tokens),0)::int AS input_tokens,
            COALESCE(SUM(output_tokens),0)::int AS output_tokens
     FROM llm_usage WHERE created_at > NOW() - ($1 || ' hours')::interval
     GROUP BY purpose ORDER BY calls DESC`,
    [sinceHours],
  );
  return { ...overall.rows[0], by_purpose: byPurpose.rows };
}
