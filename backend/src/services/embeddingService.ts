/**
 * Embedding Service
 *
 * Generates vector embeddings for text chunks.
 * Uses a simple TF-IDF / hash-based approach for zero-dependency local embeddings,
 * or an external embedding API if configured.
 *
 * Strategy:
 *  1. If EMBEDDING_API_URL is set → call external API (OpenAI-compatible format)
 *  2. Otherwise → use local hash-based embeddings (good enough for prototype)
 */

const EMBEDDING_DIM = 384; // Matches common sentence-transformer models
const EMBEDDING_API_URL = process.env.EMBEDDING_API_URL; // e.g., "https://api.openai.com/v1/embeddings"
const EMBEDDING_API_KEY = process.env.EMBEDDING_API_KEY;
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "text-embedding-3-small";

/**
 * Local hash-based embedding: deterministic, zero-dependency.
 * Uses character n-gram hashing to create a pseudo-semantic vector.
 * Good enough for prototype; external API gives much better quality.
 */
function localEmbed(text: string): number[] {
  const vec = new Float32Array(EMBEDDING_DIM).fill(0);
  const lower = text.toLowerCase().replace(/[^a-z0-9\s]/g, "");
  const words = lower.split(/\s+/).filter(Boolean);

  // Word-level hashing
  for (const word of words) {
    for (let n = 2; n <= 4; n++) {
      for (let i = 0; i <= word.length - n; i++) {
        const ngram = word.slice(i, i + n);
        let hash = 0;
        for (let j = 0; j < ngram.length; j++) {
          hash = ((hash << 5) - hash + ngram.charCodeAt(j)) | 0;
        }
        const idx = Math.abs(hash) % EMBEDDING_DIM;
        vec[idx] += hash > 0 ? 1 : -1;
      }
    }
  }

  // L2 normalize
  let norm = 0;
  for (let i = 0; i < EMBEDDING_DIM; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm) || 1;
  const result: number[] = [];
  for (let i = 0; i < EMBEDDING_DIM; i++) result.push(vec[i] / norm);
  return result;
}

/**
 * External API embedding (OpenAI-compatible format).
 */
async function apiEmbed(texts: string[]): Promise<number[][]> {
  if (!EMBEDDING_API_URL || !EMBEDDING_API_KEY) {
    throw new Error("EMBEDDING_API_URL and EMBEDDING_API_KEY must be set for API embeddings");
  }

  const res = await fetch(EMBEDDING_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${EMBEDDING_API_KEY}`,
    },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: texts }),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`Embedding API error ${res.status}: ${err}`);
  }

  const data = (await res.json()) as { data: { embedding: number[]; index: number }[] };
  // Sort by index to maintain order
  return data.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

/**
 * Generate embeddings for one or more text chunks.
 */
export async function embed(texts: string[]): Promise<number[][]> {
  if (EMBEDDING_API_URL && EMBEDDING_API_KEY) {
    // Batch in groups of 20 to avoid API limits
    const results: number[][] = [];
    for (let i = 0; i < texts.length; i += 20) {
      const batch = texts.slice(i, i + 20);
      const batchResults = await apiEmbed(batch);
      results.push(...batchResults);
    }
    return results;
  }

  // Local fallback
  return texts.map(localEmbed);
}

/**
 * Get the embedding dimension (needed for Qdrant collection creation).
 */
export function getEmbeddingDim(): number {
  if (EMBEDDING_API_URL && EMBEDDING_MODEL === "text-embedding-3-small") return 1536;
  if (EMBEDDING_API_URL && EMBEDDING_MODEL === "text-embedding-3-large") return 3072;
  return EMBEDDING_DIM;
}
