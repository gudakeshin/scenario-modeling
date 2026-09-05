import { z } from "zod";

/** Mirrors frontend Message metadata shape (frontend/src/types/chat.ts) — stored as JSONB. */
export const messageMetadataSchema = z
  .object({
    thinking: z
      .object({
        thinking: z.string(),
        intent: z.string(),
        assumptions: z.array(z.string()),
        second_order_effects: z.array(z.string()),
        duration_ms: z.number(),
      })
      .optional(),
    agentTrace: z
      .array(
        z.object({
          tool: z.string(),
          input: z.unknown(),
          output: z.unknown(),
        }),
      )
      .optional(),
    causalChain: z
      .array(
        z.object({
          step: z.string(),
          detail: z.string().optional(),
          kind: z.enum(["decomposition", "research", "levers", "preview", "other"]).optional(),
        }),
      )
      .optional(),
    agentConfidence: z.number().optional(),
    agentCitations: z
      .array(
        z.object({
          source: z.string(),
          snippet: z.string().optional(),
          url: z.string().optional(),
        }),
      )
      .optional(),
    previewPl: z.record(z.number()).optional(),
    previewReconciliation: z
      .object({
        reconciled: z.boolean(),
        max_abs_diff: z.number(),
        message: z.string().optional(),
      })
      .optional(),
    constraintViolations: z
      .array(
        z.object({
          lever: z.string(),
          reason: z.string(),
        }),
      )
      .optional(),
  })
  .partial();

export const createConversationSchema = z.object({
  /** Optional client-generated id — the frontend creates real UUIDs up front so
   *  local and persisted conversation ids never need remapping after create. */
  id: z.string().uuid().optional(),
  title: z.string().trim().min(1).max(255).default("New scenario"),
  scenario_id: z.string().uuid().optional(),
  session_id: z.string().min(1).max(255).optional(),
});

export const updateConversationSchema = z.object({
  title: z.string().trim().min(1).max(255).optional(),
  scenario_id: z.string().uuid().nullable().optional(),
  session_id: z.string().min(1).max(255).nullable().optional(),
});

export const appendMessageSchema = z.object({
  id: z.string().min(1).max(100).optional(),
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1).max(200_000),
  timestamp: z.coerce.date().optional(),
  metadata: messageMetadataSchema.optional(),
});

export type CreateConversationBody = z.infer<typeof createConversationSchema>;
export type UpdateConversationBody = z.infer<typeof updateConversationSchema>;
export type AppendMessageBody = z.infer<typeof appendMessageSchema>;
