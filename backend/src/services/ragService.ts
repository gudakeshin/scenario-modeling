/**
 * RAG Service — retrieve document chunks from Postgres and answer with Claude.
 * (Qdrant removed; LlamaParse handles ingest parsing.)
 */

import { searchDocumentChunksInDb, listDocumentConversationMessages } from "./documentService.js";
import { callClaude } from "./llmClient.js";
import { logger } from "../logger.js";

const TOP_K = 6;
const MAX_HISTORY_TURNS = 8;
const MAX_HISTORY_CHARS = 6000;

export interface RAGResponse {
  answer: string;
  sources: {
    text: string;
    document_name: string;
    chunk_index: number;
    score: number;
  }[];
  notice?: string;
}

export interface RAGConversationTurn {
  role: string;
  content: string;
}

function formatConversationHistory(turns: RAGConversationTurn[]): string {
  if (!turns.length) return "";
  const clipped: string[] = [];
  let total = 0;
  // Prefer recent turns
  const recent = turns.slice(-MAX_HISTORY_TURNS * 2);
  for (const t of recent) {
    const role = t.role === "assistant" ? "Assistant" : "User";
    const line = `${role}: ${t.content.trim()}`;
    if (total + line.length > MAX_HISTORY_CHARS) break;
    clipped.push(line);
    total += line.length;
  }
  if (!clipped.length) return "";
  return `Prior conversation in this document chat (most recent last):\n${clipped.join("\n\n")}\n\n---\n\n`;
}

export async function queryDocument(
  question: string,
  workspaceId: string,
  documentId?: string,
  opts?: {
    conversationId?: string | null;
    conversationHistory?: RAGConversationTurn[];
  },
): Promise<RAGResponse> {
  const results = await searchDocumentChunksInDb(question, workspaceId, TOP_K, documentId);

  if (results.length === 0) {
    return {
      answer: "I couldn't find any relevant information in the uploaded documents to answer this question.",
      sources: [],
    };
  }

  let historyTurns = opts?.conversationHistory ?? [];
  if ((!historyTurns || historyTurns.length === 0) && opts?.conversationId) {
    try {
      const loaded = await listDocumentConversationMessages(opts.conversationId, workspaceId);
      historyTurns = loaded.map((m) => ({ role: m.role, content: m.content }));
    } catch (e) {
      logger.warn({ err: e }, "[RAG] Failed to load conversation history");
    }
  }

  const historyBlock = formatConversationHistory(historyTurns);

  const context = results
    .map((r, i) => `[Source ${i + 1}] (${r.document_name}, chunk ${r.chunk_index}, relevance: ${(r.score * 100).toFixed(0)}%)\n${r.text}`)
    .join("\n\n---\n\n");

  const systemPrompt = `You are a knowledgeable analyst helping users understand their documents. 
Answer the user's question based ONLY on the provided document excerpts and prior conversation turns when relevant. 
If the excerpts don't contain enough information to fully answer, say so clearly.
Always cite which source(s) you're drawing from using [Source N] references.
Be concise, accurate, and professional.
Use prior conversation for continuity (follow-ups, pronouns, earlier clarifications) but do not invent facts not present in the excerpts.`;

  const userMessage = `${historyBlock}Here are relevant excerpts from the uploaded documents:

${context}

---

Question: ${question}

Please answer based on the document excerpts above. Cite your sources using [Source N] references.`;

  let answer: string;
  try {
    answer = await callClaude({
      system: systemPrompt,
      userMessage,
      maxTokens: 1500,
    });
  } catch (e) {
    logger.error({ err: e }, "Claude call failed in RAG:");
    answer =
      "I found relevant passages but couldn't generate a synthesized answer (AI service unavailable).\n\n" +
      results
        .slice(0, 3)
        .map((r, i) => `**Source ${i + 1}** (${r.document_name}):\n> ${r.text.slice(0, 300)}...`)
        .join("\n\n");
  }

  return {
    answer,
    sources: results.map((r) => ({
      text: r.text.slice(0, 200) + (r.text.length > 200 ? "..." : ""),
      document_name: r.document_name,
      chunk_index: r.chunk_index,
      score: r.score,
    })),
  };
}
