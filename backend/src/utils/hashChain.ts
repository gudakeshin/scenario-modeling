import { createHash } from "node:crypto";

/** Deterministic JSON serialization for immutable chain payloads. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`).join(",")}}`;
}

export function computeChainHash(prevHash: string, canonicalPayload: string): string {
  return createHash("sha256").update(`${prevHash}${canonicalPayload}`, "utf8").digest("hex");
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
