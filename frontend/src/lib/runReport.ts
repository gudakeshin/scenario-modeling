/**
 * Turns a simulation result into the messages a reader needs.
 *
 * This exists as one function so that "which findings reach the transcript" is
 * a single decision with a single test. It was previously spread across the run
 * handler, and `notices` — the field carrying period outliers, overrides that
 * moved nothing, and accepted data issues — was simply never read, so those
 * findings were computed, returned, and silently dropped.
 */

import { formatFidelityViolations } from "./metrics";
import type { SimulationResult } from "./api";

export interface RunReportSection {
  kind: "notices" | "absurdity" | "fidelity" | "formula_errors";
  text: string;
}

function noticeLines(notices: SimulationResult["notices"]): string[] {
  return (notices ?? [])
    .map((n) => (typeof n === "string" ? n : n.message))
    .filter((n): n is string => Boolean(n && n.trim()));
}

export function buildRunReportSections(result: SimulationResult): RunReportSection[] {
  const sections: RunReportSection[] = [];

  const notices = noticeLines(result.notices);
  if (notices.length > 0) {
    sections.push({
      kind: "notices",
      text:
        "**Things to check in this result:**\n" + notices.map((n) => `- ${n}`).join("\n"),
    });
  }

  if (result.absurdity_warnings && result.absurdity_warnings.length > 0) {
    sections.push({
      kind: "absurdity",
      text:
        "**Validation Warnings:**\n" +
        result.absurdity_warnings.map((w) => `- ${w}`).join("\n") +
        "\n\n_The model detected potentially disproportionate results. Please review the parameters above._",
    });
  }

  const fidelityText = formatFidelityViolations(result.fidelity);
  if (fidelityText) sections.push({ kind: "fidelity", text: fidelityText });

  if (result.formula_error_metrics && result.formula_error_metrics.length > 0) {
    sections.push({
      kind: "formula_errors",
      text:
        "**Formula / numeric errors:**\n" +
        result.formula_error_metrics
          .map(
            (e) =>
              `- **${e.metric_id}**: ${e.reason}${e.raw_value != null ? ` (${String(e.raw_value)})` : ""}`,
          )
          .join("\n") +
        "\n\n_Non-finite core metrics fail the run; other invalid metrics are omitted from the P&L map._",
    });
  }

  return sections;
}
