import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import axe from "axe-core";
import { AnalysisModal } from "./AnalysisModal";

describe("AnalysisModal accessibility", () => {
  it("has no critical axe violations for dialog semantics", async () => {
    const { container } = render(
      <AnalysisModal title="Sensitivity analysis" onCollapse={vi.fn()}>
        <button type="button">Close panel</button>
        <p>Analysis content</p>
      </AnalysisModal>
    );

    const results = await axe.run(container, {
      rules: {
        // jsdom lacks full layout/color contrast engine
        "color-contrast": { enabled: false },
      },
    });

    const serious = results.violations.filter(
      (v) => v.impact === "critical" || v.impact === "serious"
    );
    expect(serious).toEqual([]);
  });

  it("exposes dialog role and accessible name", () => {
    const { getByRole } = render(
      <AnalysisModal title="Monte Carlo" onCollapse={vi.fn()}>
        <button type="button">Done</button>
      </AnalysisModal>
    );

    const dialog = getByRole("dialog", { name: "Monte Carlo" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
  });
});
