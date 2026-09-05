import { describe, expect, it } from "vitest";
import { buildRunReportSections } from "./runReport";
import type { SimulationResult } from "./api";

const baseResult: SimulationResult = {
  scenario_id: "s1",
  pl: { ebitda: 100 },
  variables: {},
};

describe("buildRunReportSections", () => {
  it("reports run notices — the findings that used to be dropped", () => {
    // These are exactly what the backend computes and returns: an outlier it
    // detected, a lever that moved nothing, and a data issue somebody accepted.
    const sections = buildRunReportSections({
      ...baseResult,
      notices: [
        "Period outlier: gross_revenue is May-24=77,409.77 against a median of 1,595.42 across 12 periods.",
        "These parameters changed a model cell but moved no output metric: marketing_spend_of_revenue (Assumptions!B25).",
        'Accepted data issue — A period is far out of line (Volume_Plan!C4, D4): "Known bad source extract"',
      ],
    });

    const notices = sections.find((s) => s.kind === "notices");
    expect(notices, "run notices must reach the transcript").toBeDefined();
    expect(notices!.text).toContain("May-24");
    expect(notices!.text).toContain("marketing_spend_of_revenue");
    expect(notices!.text).toContain("Known bad source extract");
  });

  it("accepts notices in object form as well as strings", () => {
    const sections = buildRunReportSections({
      ...baseResult,
      notices: [{ type: "warning", message: "Structured notice" }] as SimulationResult["notices"],
    });
    expect(sections.find((s) => s.kind === "notices")?.text).toContain("Structured notice");
  });

  it("emits nothing when the run is clean", () => {
    expect(buildRunReportSections(baseResult)).toEqual([]);
  });

  it("keeps absurdity warnings and formula errors distinct from notices", () => {
    const sections = buildRunReportSections({
      ...baseResult,
      notices: ["a notice"],
      absurdity_warnings: ["ebitda changed by 900%"],
      formula_error_metrics: [{ metric_id: "revenue", reason: "non_finite" }],
    });
    expect(sections.map((s) => s.kind)).toEqual(["notices", "absurdity", "formula_errors"]);
  });

  it("drops empty notice entries rather than emitting a blank bullet", () => {
    const sections = buildRunReportSections({
      ...baseResult,
      notices: ["", "   "],
    });
    expect(sections).toEqual([]);
  });
});
