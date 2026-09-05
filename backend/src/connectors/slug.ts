/** Stable source identifier normalisation shared by planning connectors. */
export function slugId(raw: string): string {
  return (
    raw
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 120) || "id"
  );
}
