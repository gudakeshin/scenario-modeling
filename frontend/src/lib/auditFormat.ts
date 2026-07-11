/** Turn audit action_details into readable key/value rows (not a JSON dump). */

export interface AuditDetailRow {
  key: string;
  value: string;
}

function humanizeKey(key: string): string {
  return key
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatPrimitive(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") {
    return Number.isFinite(value) ? value.toLocaleString() : String(value);
  }
  if (typeof value === "string") return value || "—";
  return String(value);
}

/**
 * Flatten action_details into display rows.
 * Nested objects become "Parent › Child" keys; arrays of primitives join with commas.
 * Skips `touched_levers_snapshot` (rendered separately).
 */
export function formatAuditDetails(
  details: Record<string, unknown> | null | undefined
): AuditDetailRow[] {
  if (!details || typeof details !== "object") return [];

  const rows: AuditDetailRow[] = [];

  const walk = (obj: Record<string, unknown>, prefix = "") => {
    for (const [rawKey, value] of Object.entries(obj)) {
      if (rawKey === "touched_levers_snapshot") continue;
      const label = prefix ? `${prefix} › ${humanizeKey(rawKey)}` : humanizeKey(rawKey);

      if (value === null || value === undefined) {
        rows.push({ key: label, value: "—" });
      } else if (Array.isArray(value)) {
        if (value.length === 0) {
          rows.push({ key: label, value: "(none)" });
        } else if (value.every((v) => typeof v !== "object" || v === null)) {
          rows.push({ key: label, value: value.map(formatPrimitive).join(", ") });
        } else {
          rows.push({
            key: label,
            value: value
              .map((v, i) =>
                typeof v === "object" && v !== null
                  ? `#${i + 1}: ${Object.entries(v as Record<string, unknown>)
                      .map(([k, val]) => `${humanizeKey(k)}=${formatPrimitive(val)}`)
                      .join(", ")}`
                  : formatPrimitive(v)
              )
              .join("; "),
          });
        }
      } else if (typeof value === "object") {
        walk(value as Record<string, unknown>, label);
      } else {
        rows.push({ key: label, value: formatPrimitive(value) });
      }
    }
  };

  walk(details);
  return rows;
}

/** Short string list from touched_levers_snapshot when present. */
export function formatTouchedLevers(
  details: Record<string, unknown> | null | undefined
): string[] {
  if (!details) return [];
  const snap = details.touched_levers_snapshot;
  if (!Array.isArray(snap)) return [];
  return snap.map((item) => {
    if (typeof item === "string") return item;
    if (item && typeof item === "object") {
      const o = item as Record<string, unknown>;
      const id = o.variable_id ?? o.id ?? o.name ?? o.lever;
      const val = o.value ?? o.scenario_value ?? o.delta;
      if (id != null && val != null) return `${formatPrimitive(id)}: ${formatPrimitive(val)}`;
      if (id != null) return formatPrimitive(id);
      return JSON.stringify(item);
    }
    return formatPrimitive(item);
  });
}
