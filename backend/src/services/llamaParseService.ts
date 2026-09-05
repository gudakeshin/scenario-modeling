/**
 * LlamaParse (LlamaCloud) document parsing.
 * Replaces local PDF/DOCX extraction and the former Qdrant-dependent ingest path
 * for rich document formats. Chunks are stored in Postgres.
 */

import { LlamaParseReader } from "llama-cloud-services/reader";
import { config } from "../config.js";

const LLAMA_PARSE_TYPES = new Set([
  "application/pdf",
  "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "pptx",
  "text/csv",
  "csv",
  "text/html",
  "html",
]);

export function isLlamaParseConfigured(): boolean {
  return !!config.LLAMA_CLOUD_API_KEY;
}

export function shouldUseLlamaParse(fileType: string, filename: string): boolean {
  if (!isLlamaParseConfigured()) return false;
  const lower = filename.toLowerCase();
  if (/\.(pdf|docx|pptx|xlsx|html|htm)$/i.test(lower)) return true;
  // CSV/TXT usually fine locally; still allow LlamaParse for CSV if desired via env
  if (config.LLAMA_PARSE_CSV && (/\.csv$/i.test(lower) || fileType.includes("csv"))) return true;
  return LLAMA_PARSE_TYPES.has(fileType);
}

/**
 * Parse a file buffer via LlamaParse and return markdown/text.
 */
export async function parseWithLlamaParse(
  buffer: Buffer,
  filename: string
): Promise<string> {
  if (!config.LLAMA_CLOUD_API_KEY) {
    throw new Error("LLAMA_CLOUD_API_KEY is not configured");
  }

  const reader = new LlamaParseReader({
    apiKey: config.LLAMA_CLOUD_API_KEY,
    resultType: "markdown",
    verbose: config.NODE_ENV === "development",
    ignoreErrors: false,
    // Prefer tables as markdown for financial docs
    compact_markdown_table: true,
    parsingInstruction:
      "Extract all financial tables, line items, amounts, and headers accurately. Preserve table structure in markdown.",
  });

  const docs = await reader.loadDataAsContent(
    new Uint8Array(buffer),
    filename
  );

  const text = docs
    .map((d) => {
      const anyDoc = d as { text?: string; getText?: () => string };
      if (typeof anyDoc.getText === "function") return anyDoc.getText();
      return anyDoc.text || String(d);
    })
    .filter(Boolean)
    .join("\n\n")
    .trim();

  if (!text) {
    throw new Error("LlamaParse returned empty content");
  }
  return text;
}

export async function testLlamaParseConnection(): Promise<boolean> {
  return isLlamaParseConfigured();
}
