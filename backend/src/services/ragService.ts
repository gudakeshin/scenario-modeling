/**
 * RAG Service — retrieve document chunks from Postgres and answer with Claude.
 * (Qdrant removed; LlamaParse handles ingest parsing.)
 */

import { searchDocumentChunksInDb } from "./documentService.js";
import { callClaude } from "./llmClient.js";
import { logger } from "../logger.js";

const TOP_K = 6;

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

export async function queryDocument(
  question: string,
  documentId?: string
): Promise<RAGResponse> {
  const results = await searchDocumentChunksInDb(question, TOP_K, documentId);

  if (results.length === 0) {
    return {
      answer: "I couldn't find any relevant information in the uploaded documents to answer this question.",
      sources: [],
    };
  }

  const context = results
    .map((r, i) => `[Source ${i + 1}] (${r.document_name}, chunk ${r.chunk_index}, relevance: ${(r.score * 100).toFixed(0)}%)\n${r.text}`)
    .join("\n\n---\n\n");

  const systemPrompt = `You are a knowledgeable analyst helping users understand their documents. 
Answer the user's question based ONLY on the provided document excerpts. 
If the excerpts don't contain enough information to fully answer, say so clearly.
Always cite which source(s) you're drawing from using [Source N] references.
Be concise, accurate, and professional.`;

  const userMessage = `Here are relevant excerpts from the uploaded documents:

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
