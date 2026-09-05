/**
 * CSV tabular ingestor — typed single-sheet data source.
 * CSVs cannot contain formulas or multi-worksheet links; they enrich context
 * as data-only artifacts and must not invent calculation relationships.
 */

import { parse as parseCsv } from "csv-parse/sync";
import { detectDenominationFromText, toCanonical, type CurrencyUnit } from "./denomination.js";
import {
  ARTIFACT_VERSION,
  type TabularArtifact,
  type TabularColumn,
} from "./ingestionArtifacts.js";

const SAMPLE_ROW_CAP = 50;

function inferType(values: string[]): TabularColumn["inferredType"] {
  const nonEmpty = values.map((v) => v.trim()).filter(Boolean);
  if (nonEmpty.length === 0) return "empty";
  let numeric = 0;
  for (const v of nonEmpty) {
    const cleaned = v.replace(/,/g, "").replace(/^[$₹€£]/, "");
    if (/^-?\d+(\.\d+)?%?$/.test(cleaned) || /^-?\d+(\.\d+)?\s*[a-zA-Z]{1,4}$/.test(cleaned)) {
      numeric++;
    }
  }
  return numeric / nonEmpty.length >= 0.6 ? "number" : "string";
}

function coerceCell(raw: string, type: TabularColumn["inferredType"]): string | number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (type !== "number") return trimmed;
  const cleaned = trimmed.replace(/,/g, "").replace(/^[$₹€£]/, "").replace(/%$/, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : trimmed;
}

export function extractTabularArtifact(buffer: Buffer): TabularArtifact {
  const records = parseCsv(buffer, {
    bom: true,
    relax_column_count: true,
    skip_empty_lines: true,
  }) as string[][];

  if (records.length === 0) {
    return {
      artifact_version: ARTIFACT_VERSION,
      kind: "tabular",
      sheetName: "CSV",
      headers: [],
      columns: [],
      rowCount: 0,
      sampleRows: [],
      delimiter: ",",
      encoding: "utf-8",
      dataOnly: true,
      warnings: [
        {
          code: "csv_data_only",
          message: "CSV is empty — data-only source with no formulas or worksheet links",
        },
      ],
    };
  }

  const headerRow = records[0].map((h, i) => (h || "").trim() || `column_${i + 1}`);
  const dataRows = records.slice(1);
  const columns: TabularColumn[] = headerRow.map((name, index) => {
    const colValues = dataRows.map((r) => r[index] ?? "");
    return { name, index, inferredType: inferType(colValues) };
  });

  const sampleRows: Array<Record<string, string | number | null>> = [];
  for (const row of dataRows.slice(0, SAMPLE_ROW_CAP)) {
    const obj: Record<string, string | number | null> = {};
    for (const col of columns) {
      obj[col.name] = coerceCell(row[col.index] ?? "", col.inferredType);
    }
    sampleRows.push(obj);
  }

  const denom = detectDenominationFromText(
    records
      .slice(0, 20)
      .map((r) => r.join(" "))
      .join("\n"),
  );

  // Canonicalize numeric sample cells into Million when a unit is detected
  if (denom.unit) {
    for (const row of sampleRows) {
      for (const col of columns) {
        if (col.inferredType !== "number") continue;
        const v = row[col.name];
        if (typeof v === "number" && Number.isFinite(v)) {
          try {
            row[col.name] = toCanonical(v, {
              unit: denom.unit as CurrencyUnit,
              currency: denom.currency,
            }).value;
          } catch {
            /* keep raw when FX missing for mixed currency */
          }
        }
      }
    }
  }

  return {
    artifact_version: ARTIFACT_VERSION,
    kind: "tabular",
    sheetName: "CSV",
    headers: headerRow,
    columns,
    rowCount: dataRows.length,
    sampleRows,
    delimiter: ",",
    encoding: "utf-8",
    currency: denom.currency,
    unit: denom.unit,
    dataOnly: true,
    warnings: [
      {
        code: "csv_data_only",
        message:
          "CSV ingested as a typed single-sheet data source. No formulas or cross-worksheet links are present or inferred.",
      },
    ],
  };
}

/** Text rendering for secondary RAG chunks (same shape as historical CSV extract). */
export function tabularToSearchText(artifact: TabularArtifact, allRecords?: string[][]): string {
  if (allRecords && allRecords.length > 0) {
    return allRecords
      .map((row, i) => `Row ${i + 1}:\t${row.map((c) => String(c ?? "").trim()).join("\t")}`)
      .join("\n");
  }
  const lines = [`Sheet: ${artifact.sheetName} (data-only CSV)`];
  if (artifact.currency || artifact.unit) {
    lines.push(`Denomination: ${[artifact.currency, artifact.unit].filter(Boolean).join(" ")}`);
  }
  lines.push(`Headers:\t${artifact.headers.join("\t")}`);
  for (let i = 0; i < artifact.sampleRows.length; i++) {
    const row = artifact.sampleRows[i];
    lines.push(
      `Row ${i + 2}:\t${artifact.headers.map((h) => String(row[h] ?? "")).join("\t")}`,
    );
  }
  return lines.join("\n");
}
