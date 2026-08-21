import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import axe from "axe-core";
import { Stepper } from "./Stepper";
import { ConfirmDialog } from "../ConfirmDialog";
import { ProviderPicker } from "./ProviderPicker";

describe("Data & Models primitives accessibility", () => {
  it("Stepper has no critical axe violations", async () => {
    const { container } = render(
      <Stepper
        steps={[
          { id: "scope", label: "Scope" },
          { id: "review", label: "Review" },
          { id: "importing", label: "Importing" },
        ]}
        current="review"
        completed={["scope"]}
      />,
    );

    const results = await axe.run(container, {
      rules: { "color-contrast": { enabled: false } },
    });
    const serious = results.violations.filter(
      (v) => v.impact === "critical" || v.impact === "serious",
    );
    expect(serious).toEqual([]);
  });

  it("ConfirmDialog exposes alertdialog semantics", async () => {
    const { getByRole, container } = render(
      <ConfirmDialog
        open
        title="Remove connection?"
        description="This cannot be undone."
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(getByRole("alertdialog", { name: "Remove connection?" })).toHaveAttribute(
      "aria-modal",
      "true",
    );

    const results = await axe.run(container, {
      rules: { "color-contrast": { enabled: false } },
    });
    const serious = results.violations.filter(
      (v) => v.impact === "critical" || v.impact === "serious",
    );
    expect(serious).toEqual([]);
  });

  it("ProviderPicker uses radiogroup", () => {
    const { getByRole } = render(
      <ProviderPicker value="mock" onChange={vi.fn()} />,
    );
    expect(getByRole("radiogroup", { name: "Provider" })).toBeTruthy();
  });
});
