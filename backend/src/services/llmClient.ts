/**
 * Shared LLM Client — wraps the Anthropic Claude API.
 *
 * All LLM calls go through this module so retries, timeouts, model
 * routing, and usage tracking are handled in one place instead of being
 * (or not being) reimplemented per caller.
 *
 * Stable system prompts are marked with Anthropic `cache_control: ephemeral`
 * so repeated calls can hit prompt cache (cost/latency win, no behavior change).
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

/**
 * Opus 4.7+, Opus 4.8, and Sonnet 5 reject temperature/top_p/top_k with HTTP 400.
 * Sonnet 4.5 / Haiku 4.5 still accept them.
 */
export function modelSupportsSamplingParams(model: string): boolean {
  const m = model.toLowerCase();
  // Match claude-sonnet-5 / claude-sonnet-5-… but not claude-sonnet-4-5-…
  if (/^claude-sonnet-5(?:$|-)/.test(m)) return false;
  const opusMinor = m.match(/claude-opus-4-(\d+)/);
  if (opusMinor && Number(opusMinor[1]) >= 7) return false;
  if (/^claude-opus-[5-9](?:$|-)/.test(m)) return false;
  return true;
}

/** Spread into messages.create so unsupported models omit temperature entirely. */
function samplingParams(model: string, temperature: number): { temperature?: number } {
  return modelSupportsSamplingParams(model) ? { temperature } : {};
}

export type LlmPurpose =
  | "parse"
  | "reflection"
  | "business_analysis"
  | "qa"
  | "context_build"
  | "narrative"
  | "rag"
  | "connector_map"
  | "agent"
  | "other";

export function getApiKey(): string | undefined {
  return process.env.ANTHROPIC_API_KEY;
}

/** Legacy single-model getter (kept for narrativeService/ragService free-text calls). */
export function getModel(): string {
  return process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;
}

/** Model routing: parse/cheap, analysis/Sonnet, QA+agent/Opus. */
export function modelForPurpose(purpose: LlmPurpose): string {
  switch (purpose) {
    case "parse":
    case "reflection":
      return config.anthropicModelParse || getModel();
    case "business_analysis":
    case "context_build":
    case "narrative":
      return config.anthropicModelAnalysis || getModel();
    case "qa":
    case "agent":
      return config.anthropicModelQa || config.anthropicModelAnalysis || getModel();
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

/** Mark a stable system prompt as an Anthropic prompt-cache breakpoint. */
function cachedSystem(text: string): Anthropic.TextBlockParam[] {
  return [
    {
      type: "text",
      text,
      cache_control: { type: "ephemeral" },
    },
  ];
}

function usageCacheTokens(usage?: {
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
} | null): { cacheReadInputTokens: number; cacheCreationInputTokens: number } {
  return {
    cacheReadInputTokens: usage?.cache_read_input_tokens ?? 0,
    cacheCreationInputTokens: usage?.cache_creation_input_tokens ?? 0,
  };
}

async function logUsage(entry: {
  purpose: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  latencyMs: number;
  succeeded: boolean;
  errorMessage?: string;
}): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO llm_usage (
         purpose, model, input_tokens, output_tokens,
         cache_read_input_tokens, cache_creation_input_tokens,
         latency_ms, succeeded, error_message
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        entry.purpose,
        entry.model,
        entry.inputTokens,
        entry.outputTokens,
        entry.cacheReadInputTokens ?? 0,
        entry.cacheCreationInputTokens ?? 0,
        entry.latencyMs,
        entry.succeeded,
        entry.errorMessage ?? null,
      ],
    );
  } catch (e) {
    // Usage logging must never break the caller's actual LLM call.
    // Older DBs without cache columns: retry without them once.
    const msg = (e as Error).message || "";
    if (msg.includes("cache_read_input_tokens") || msg.includes("cache_creation_input_tokens")) {
      try {
        await pool.query(
          `INSERT INTO llm_usage (purpose, model, input_tokens, output_tokens, latency_ms, succeeded, error_message)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [entry.purpose, entry.model, entry.inputTokens, entry.outputTokens, entry.latencyMs, entry.succeeded, entry.errorMessage ?? null],
        );
      } catch (e2) {
        logger.warn({ detail: (e2 as Error).message }, "[llmClient] Failed to log usage (fallback):");
      }
    } else {
      logger.warn({ detail: msg }, "[llmClient] Failed to log usage:");
    }
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
        ...samplingParams(model, opts.temperature ?? 0.2),
        system: cachedSystem(opts.system),
        messages: [{ role: "user", content: opts.userMessage }],
      },
      { maxRetries: MAX_RETRIES, timeout: REQUEST_TIMEOUT_MS },
    );

    const block = response.content[0];
    if (block.type !== "text" || !block.text) {
      throw new Error("Empty Claude response");
    }
    const cache = usageCacheTokens(response.usage);
    void logUsage({
      purpose: opts.purpose ?? "other",
      model,
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
      ...cache,
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
        ...samplingParams(model, opts.temperature ?? 0.2),
        system: cachedSystem(opts.system),
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

    const cache = usageCacheTokens(response.usage);
    void logUsage({
      purpose: opts.purpose ?? "other",
      model,
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
      ...cache,
      latencyMs: Date.now() - started,
      succeeded: true,
    });

    if (response.stop_reason === "max_tokens") {
      throw new LlmSchemaError(
        `Structured output truncated at max_tokens=${opts.maxTokens ?? 2000} for tool '${opts.toolName}' — raise maxTokens for this call`,
      );
    }

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

export interface AgentTool {
  name: string;
  description: string;
  inputSchema: Anthropic.Tool.InputSchema;
  handler: (input: unknown) => Promise<unknown>;
}

export interface AgentLoopResult {
  result: unknown;
  steps: Array<{ tool: string; input: unknown; output: unknown }>;
  stopped_reason: string;
}

/**
 * Multi-turn Claude tool loop. Continues until the model calls `terminalToolName`
 * (validated against `terminalSchema`), or max steps / timeout is hit.
 */
export async function callClaudeAgentLoop(opts: {
  system: string;
  userMessage: string;
  tools: AgentTool[];
  terminalToolName: string;
  terminalSchema: z.ZodType<any>;
  maxSteps?: number;
  purpose?: LlmPurpose;
}): Promise<AgentLoopResult> {
  const client = getClient();
  const purpose = opts.purpose ?? "agent";
  const model = modelForPurpose(purpose);
  const maxSteps = opts.maxSteps ?? config.AGENT_MAX_STEPS;
  const timeoutMs = config.AGENT_TIMEOUT_MS;
  const started = Date.now();
  const steps: AgentLoopResult["steps"] = [];

  const toolsByName = new Map(opts.tools.map((t) => [t.name, t]));
  if (!toolsByName.has(opts.terminalToolName)) {
    throw new Error(`Terminal tool "${opts.terminalToolName}" must be included in tools`);
  }

  const anthropicTools: Anthropic.Tool[] = opts.tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));

  type Msg = Anthropic.MessageParam;
  const messages: Msg[] = [{ role: "user", content: opts.userMessage }];
  const system = cachedSystem(opts.system);

  let totalIn = 0;
  let totalOut = 0;
  let totalCacheRead = 0;
  let totalCacheCreation = 0;

  try {
    for (let step = 0; step < maxSteps; step++) {
      if (Date.now() - started > timeoutMs) {
        void logUsage({
          purpose,
          model,
          inputTokens: totalIn,
          outputTokens: totalOut,
          cacheReadInputTokens: totalCacheRead,
          cacheCreationInputTokens: totalCacheCreation,
          latencyMs: Date.now() - started,
          succeeded: false,
          errorMessage: "agent_timeout",
        });
        return { result: null, steps, stopped_reason: "timeout" };
      }

      const remaining = Math.max(5_000, timeoutMs - (Date.now() - started));
      const response = await client.messages.create(
        {
          model,
          max_tokens: 4096,
          ...samplingParams(model, 0.2),
          system,
          messages,
          tools: anthropicTools,
        },
        { maxRetries: MAX_RETRIES, timeout: Math.min(REQUEST_TIMEOUT_MS, remaining) },
      );

      totalIn += response.usage?.input_tokens ?? 0;
      totalOut += response.usage?.output_tokens ?? 0;
      const cache = usageCacheTokens(response.usage);
      totalCacheRead += cache.cacheReadInputTokens;
      totalCacheCreation += cache.cacheCreationInputTokens;

      const toolUses = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
      );

      messages.push({ role: "assistant", content: response.content });

      if (toolUses.length === 0) {
        void logUsage({
          purpose,
          model,
          inputTokens: totalIn,
          outputTokens: totalOut,
          cacheReadInputTokens: totalCacheRead,
          cacheCreationInputTokens: totalCacheCreation,
          latencyMs: Date.now() - started,
          succeeded: true,
        });
        return { result: null, steps, stopped_reason: "no_tool_use" };
      }

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const tu of toolUses) {
        const tool = toolsByName.get(tu.name);
        if (!tool) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: JSON.stringify({ error: `Unknown tool: ${tu.name}` }),
            is_error: true,
          });
          steps.push({ tool: tu.name, input: tu.input, output: { error: `Unknown tool: ${tu.name}` } });
          continue;
        }

        if (tu.name === opts.terminalToolName) {
          const parsed = opts.terminalSchema.safeParse(tu.input);
          if (!parsed.success) {
            const errOut = {
              error: `Terminal schema validation failed: ${parsed.error.message}`,
            };
            toolResults.push({
              type: "tool_result",
              tool_use_id: tu.id,
              content: JSON.stringify(errOut),
              is_error: true,
            });
            steps.push({ tool: tu.name, input: tu.input, output: errOut });
            continue;
          }
          steps.push({ tool: tu.name, input: tu.input, output: parsed.data });
          void logUsage({
            purpose,
            model,
            inputTokens: totalIn,
            outputTokens: totalOut,
            cacheReadInputTokens: totalCacheRead,
            cacheCreationInputTokens: totalCacheCreation,
            latencyMs: Date.now() - started,
            succeeded: true,
          });
          return { result: parsed.data, steps, stopped_reason: "terminal_tool" };
        }

        let output: unknown;
        try {
          output = await tool.handler(tu.input);
        } catch (e) {
          output = { error: (e as Error).message };
        }
        steps.push({ tool: tu.name, input: tu.input, output });
        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: JSON.stringify(output).slice(0, 80_000),
          is_error: !!(output && typeof output === "object" && "error" in (output as object)),
        });
      }

      if (toolResults.length > 0) {
        messages.push({ role: "user", content: toolResults });
      }
    }

    void logUsage({
      purpose,
      model,
      inputTokens: totalIn,
      outputTokens: totalOut,
      cacheReadInputTokens: totalCacheRead,
      cacheCreationInputTokens: totalCacheCreation,
      latencyMs: Date.now() - started,
      succeeded: false,
      errorMessage: "max_steps",
    });
    return { result: null, steps, stopped_reason: "max_steps" };
  } catch (e) {
    void logUsage({
      purpose,
      model,
      inputTokens: totalIn,
      outputTokens: totalOut,
      cacheReadInputTokens: totalCacheRead,
      cacheCreationInputTokens: totalCacheCreation,
      latencyMs: Date.now() - started,
      succeeded: false,
      errorMessage: (e as Error).message,
    });
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
