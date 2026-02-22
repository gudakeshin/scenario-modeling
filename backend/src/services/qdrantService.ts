/**
 * Qdrant Vector Database Service
 *
 * Handles collection management, point upsert, and similarity search.
 * Configured via QDRANT_URL and QDRANT_API_KEY environment variables.
 */

import { QdrantClient } from "@qdrant/js-client-rest";
import { getEmbeddingDim } from "./embeddingService.js";

const QDRANT_URL = process.env.QDRANT_URL || "http://localhost:6333";
const QDRANT_API_KEY = process.env.QDRANT_API_KEY || "";
const COLLECTION_NAME = process.env.QDRANT_COLLECTION || "scenario_documents";

let client: QdrantClient | null = null;

function getClient(): QdrantClient {
  if (!client) {
    client = new QdrantClient({
      url: QDRANT_URL,
      apiKey: QDRANT_API_KEY || undefined,
    });
  }
  return client;
}

/**
 * Ensure the collection exists with the right vector config.
 */
export async function ensureCollection(): Promise<void> {
  const c = getClient();
  try {
    const existing = await c.getCollection(COLLECTION_NAME);
    if (existing) return; // Already exists
  } catch {
    // Collection doesn't exist — create it
  }

  const dim = getEmbeddingDim();
  await c.createCollection(COLLECTION_NAME, {
    vectors: { size: dim, distance: "Cosine" },
  });
  console.log(`Qdrant collection '${COLLECTION_NAME}' created (dim=${dim})`);

  // Create payload index for efficient filtering by document_id
  await c.createPayloadIndex(COLLECTION_NAME, {
    field_name: "document_id",
    field_schema: "keyword",
  });
}

export interface ChunkPoint {
  id: string;
  vector: number[];
  payload: {
    document_id: string;
    document_name: string;
    chunk_index: number;
    text: string;
    page?: number;
  };
}

/**
 * Upsert chunk vectors into Qdrant.
 */
export async function upsertChunks(points: ChunkPoint[]): Promise<void> {
  const c = getClient();
  await ensureCollection();

  // Batch upserts in groups of 100
  for (let i = 0; i < points.length; i += 100) {
    const batch = points.slice(i, i + 100);
    await c.upsert(COLLECTION_NAME, {
      wait: true,
      points: batch.map((p) => ({
        id: p.id,
        vector: p.vector,
        payload: p.payload,
      })),
    });
  }
}

export interface SearchResult {
  score: number;
  text: string;
  document_id: string;
  document_name: string;
  chunk_index: number;
  page?: number;
}

/**
 * Search for similar chunks.
 * Optionally filter by a specific document_id.
 */
export async function searchChunks(
  queryVector: number[],
  topK = 5,
  documentId?: string
): Promise<SearchResult[]> {
  const c = getClient();
  await ensureCollection();

  const filter = documentId
    ? { must: [{ key: "document_id", match: { value: documentId } }] }
    : undefined;

  const results = await c.search(COLLECTION_NAME, {
    vector: queryVector,
    limit: topK,
    with_payload: true,
    filter,
  });

  return results.map((r) => ({
    score: r.score,
    text: (r.payload?.text as string) || "",
    document_id: (r.payload?.document_id as string) || "",
    document_name: (r.payload?.document_name as string) || "",
    chunk_index: (r.payload?.chunk_index as number) || 0,
    page: r.payload?.page as number | undefined,
  }));
}

/**
 * Retrieve ALL chunks for given document IDs, ordered by chunk_index.
 * Used by the context engine to reconstruct full document text.
 */
export async function getAllChunksForDocuments(documentIds: string[]): Promise<SearchResult[]> {
  const c = getClient();
  try {
    await ensureCollection();
  } catch {
    return [];
  }

  const allResults: SearchResult[] = [];

  for (const docId of documentIds) {
    let offset: string | number | undefined = undefined;
    const limit = 100;

    // Paginate through all points for this document
    while (true) {
      const response = await c.scroll(COLLECTION_NAME, {
        filter: { must: [{ key: "document_id", match: { value: docId } }] },
        limit,
        offset,
        with_payload: true,
        with_vector: false,
      });

      for (const point of response.points) {
        allResults.push({
          score: 1,
          text: (point.payload?.text as string) || "",
          document_id: (point.payload?.document_id as string) || "",
          document_name: (point.payload?.document_name as string) || "",
          chunk_index: (point.payload?.chunk_index as number) || 0,
          page: point.payload?.page as number | undefined,
        });
      }

      if (!response.next_page_offset) break;
      offset = response.next_page_offset as string | number | undefined;
    }
  }

  // Sort by document_id then chunk_index to reconstruct original order
  allResults.sort((a, b) => {
    if (a.document_id !== b.document_id) return a.document_id.localeCompare(b.document_id);
    return a.chunk_index - b.chunk_index;
  });

  return allResults;
}

/**
 * Delete all chunks for a given document.
 */
export async function deleteDocumentChunks(documentId: string): Promise<void> {
  const c = getClient();
  try {
    await c.delete(COLLECTION_NAME, {
      wait: true,
      filter: { must: [{ key: "document_id", match: { value: documentId } }] },
    });
  } catch (e) {
    console.error("Failed to delete chunks from Qdrant:", e);
  }
}

/**
 * Test Qdrant connectivity.
 */
export async function testConnection(): Promise<boolean> {
  try {
    const c = getClient();
    await c.getCollections();
    return true;
  } catch {
    return false;
  }
}
