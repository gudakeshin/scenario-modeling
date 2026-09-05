/**
 * Chat conversation persistence — CRUD for conversations + messages, scoped
 * to workspace (see backend/src/middleware/workspace.ts Scope). Mirrors the
 * connectionService.ts pattern: raw parameterized SQL via pool, explicit
 * public columns, workspace_id in every WHERE clause.
 */

import { pool } from "../db/index.js";
import type { Scope } from "../middleware/workspace.js";
import type {
  AppendMessageBody,
  CreateConversationBody,
  UpdateConversationBody,
} from "../schemas/conversations.js";

export class ConversationError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export interface ConversationSummary {
  id: string;
  workspace_id: string;
  user_id: string;
  title: string;
  scenario_id: string | null;
  session_id: string | null;
  created_at: string;
  updated_at: string;
  message_count: number;
}

export interface ConversationMessage {
  id: string;
  conversation_id: string;
  role: "user" | "assistant";
  content: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

export interface ConversationWithMessages extends ConversationSummary {
  messages: ConversationMessage[];
}

/** For SELECT queries against the aliased `chat_conversations c`. */
const CONVERSATION_COLUMNS = `
  c.id, c.workspace_id, c.user_id, c.title, c.scenario_id, c.session_id,
  c.created_at, c.updated_at
`;

/** For INSERT/UPDATE ... RETURNING, which have no table alias. */
const CONVERSATION_RETURNING_COLUMNS = `
  id, workspace_id, user_id, title, scenario_id, session_id, created_at, updated_at
`;

/** List conversations for the caller's workspace, most-recently-updated first. */
export async function listConversations(scope: Scope, limit = 100): Promise<ConversationSummary[]> {
  const r = await pool.query(
    `SELECT ${CONVERSATION_COLUMNS},
            (SELECT COUNT(*)::int FROM chat_messages m WHERE m.conversation_id = c.id) AS message_count
     FROM chat_conversations c
     WHERE c.workspace_id = $1
     ORDER BY c.updated_at DESC
     LIMIT $2`,
    [scope.workspaceId, Math.min(Math.max(limit, 1), 500)],
  );
  return r.rows as ConversationSummary[];
}

/** Fetch one conversation (workspace-scoped) with its full message history in order. */
export async function getConversation(
  scope: Scope,
  conversationId: string,
): Promise<ConversationWithMessages | null> {
  const c = await pool.query(
    `SELECT ${CONVERSATION_COLUMNS},
            (SELECT COUNT(*)::int FROM chat_messages m WHERE m.conversation_id = c.id) AS message_count
     FROM chat_conversations c
     WHERE c.workspace_id = $1 AND c.id = $2`,
    [scope.workspaceId, conversationId],
  );
  if (c.rows.length === 0) return null;

  const m = await pool.query(
    `SELECT id, conversation_id, role, content, metadata, created_at
     FROM chat_messages
     WHERE conversation_id = $1
     ORDER BY created_at ASC, id ASC`,
    [conversationId],
  );

  return {
    ...(c.rows[0] as ConversationSummary),
    messages: m.rows as ConversationMessage[],
  };
}

export async function createConversation(
  scope: Scope,
  body: CreateConversationBody,
): Promise<ConversationSummary> {
  try {
    const r = body.id
      ? await pool.query(
          `INSERT INTO chat_conversations (id, workspace_id, user_id, title, scenario_id, session_id)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (id) DO NOTHING
           RETURNING ${CONVERSATION_RETURNING_COLUMNS}`,
          [body.id, scope.workspaceId, scope.userId, body.title, body.scenario_id ?? null, body.session_id ?? null],
        )
      : await pool.query(
          `INSERT INTO chat_conversations (workspace_id, user_id, title, scenario_id, session_id)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING ${CONVERSATION_RETURNING_COLUMNS}`,
          [scope.workspaceId, scope.userId, body.title, body.scenario_id ?? null, body.session_id ?? null],
        );
    if (r.rows.length === 0) {
      // id already existed (idempotent retry from the client) — return the existing row if it's ours.
      const existing = await getConversation(scope, body.id!);
      if (existing) return existing;
      throw new ConversationError("Conversation id already in use", 409);
    }
    return { ...(r.rows[0] as ConversationSummary), message_count: 0 };
  } catch (e: unknown) {
    if ((e as { code?: string }).code === "23505") {
      throw new ConversationError("Conversation id already in use", 409);
    }
    throw e;
  }
}

export async function updateConversation(
  scope: Scope,
  conversationId: string,
  body: UpdateConversationBody,
): Promise<ConversationSummary> {
  const existing = await pool.query(
    `SELECT id FROM chat_conversations WHERE workspace_id = $1 AND id = $2`,
    [scope.workspaceId, conversationId],
  );
  if (existing.rows.length === 0) throw new ConversationError("Conversation not found", 404);

  const updates: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  if (body.title !== undefined) {
    updates.push(`title = $${i++}`);
    values.push(body.title);
  }
  if (body.scenario_id !== undefined) {
    updates.push(`scenario_id = $${i++}`);
    values.push(body.scenario_id);
  }
  if (body.session_id !== undefined) {
    updates.push(`session_id = $${i++}`);
    values.push(body.session_id);
  }
  updates.push(`updated_at = NOW()`);

  values.push(scope.workspaceId, conversationId);
  const r = await pool.query(
    `UPDATE chat_conversations SET ${updates.join(", ")}
     WHERE workspace_id = $${i++} AND id = $${i}
     RETURNING ${CONVERSATION_RETURNING_COLUMNS}`,
    values,
  );
  return { ...(r.rows[0] as ConversationSummary), message_count: 0 };
}

/** Append a message and bump the conversation's updated_at in one transaction. */
export async function appendMessage(
  scope: Scope,
  conversationId: string,
  body: AppendMessageBody,
): Promise<ConversationMessage> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query(
      `SELECT id FROM chat_conversations WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
      [scope.workspaceId, conversationId],
    );
    if (existing.rows.length === 0) {
      await client.query("ROLLBACK");
      throw new ConversationError("Conversation not found", 404);
    }

    const r = await client.query(
      `INSERT INTO chat_messages (conversation_id, role, content, metadata, created_at)
       VALUES ($1, $2, $3, $4, COALESCE($5, NOW()))
       RETURNING id, conversation_id, role, content, metadata, created_at`,
      [
        conversationId,
        body.role,
        body.content,
        body.metadata ? JSON.stringify(body.metadata) : null,
        body.timestamp ?? null,
      ],
    );
    await client.query(`UPDATE chat_conversations SET updated_at = NOW() WHERE id = $1`, [conversationId]);
    await client.query("COMMIT");
    return r.rows[0] as ConversationMessage;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function deleteConversation(scope: Scope, conversationId: string): Promise<void> {
  const r = await pool.query(
    `DELETE FROM chat_conversations WHERE workspace_id = $1 AND id = $2 RETURNING id`,
    [scope.workspaceId, conversationId],
  );
  if (r.rows.length === 0) throw new ConversationError("Conversation not found", 404);
}

export async function deleteConversations(scope: Scope, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const r = await pool.query(
    `DELETE FROM chat_conversations WHERE workspace_id = $1 AND id = ANY($2::uuid[]) RETURNING id`,
    [scope.workspaceId, ids],
  );
  return r.rows.map((row: { id: string }) => row.id);
}
