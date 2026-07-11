/**
 * Embedding Service
 *
 * Explicit provider selection via config.EMBEDDING_PROVIDER:
 *  - "none" (default): vector search disabled; callers should use keyword search
 *  - "openai": OpenAI-compatible embeddings API (requires EMBEDDING_API_URL + KEY)
 *
 * No silent local hash fallback — that produced non-semantic vectors and
 * dimension-mismatch traps against external vector DBs.
 */

import { config } from "../config.js";

const OPENAI_DIM: Record<string, number> = {
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
  "text-embedding-ada-002": 1536,
};

export function isEmbeddingEnabled(): boolean {
  return config.EMBEDDING_PROVIDER === "openai";
}

async function apiEmbed(texts: string[]): Promise<number[][]> {
  if (!config.EMBEDDING_API_URL || !config.EMBEDDING_API_KEY) {
    throw new Error(
      "EMBEDDING_PROVIDER=openai requires EMBEDDING_API_URL and EMBEDDING_API_KEY"
    );
  }

  const res = await fetch(config.EMBEDDING_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.EMBEDDING_API_KEY}`,
    },
    body: JSON.stringify({ model: config.EMBEDDING_MODEL, input: texts }),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`Embedding API error ${res.status}: ${err}`);
  }

  const data = (await res.json()) as { data: { embedding: number[]; index: number }[] };
  return data.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

/**
 * Generate embeddings for one or more text chunks.
 * Throws if provider is "none" — use keyword search instead.
 */
export async function embed(texts: string[]): Promise<number[][]> {
  if (config.EMBEDDING_PROVIDER === "none") {
    throw new Error(
      "Vector embeddings are disabled (EMBEDDING_PROVIDER=none). Use keyword document search."
    );
  }

  const results: number[][] = [];
  for (let i = 0; i < texts.length; i += 20) {
    const batch = texts.slice(i, i + 20);
    results.push(...(await apiEmbed(batch)));
  }
  return results;
}

export function getEmbeddingDim(): number {
  if (config.EMBEDDING_PROVIDER === "none") return 0;
  return OPENAI_DIM[config.EMBEDDING_MODEL] ?? 1536;
}

export function getEmbeddingProviderMeta(): { provider: string; dim: number; model: string } {
  return {
    provider: config.EMBEDDING_PROVIDER,
    dim: getEmbeddingDim(),
    model: config.EMBEDDING_PROVIDER === "openai" ? config.EMBEDDING_MODEL : "none",
  };
}
