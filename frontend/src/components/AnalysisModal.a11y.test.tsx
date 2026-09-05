import { describe, it, expect, vi } from "vitest";
import { render, act } from "@testing-library/react";
import { useState } from "react";
import axe from "axe-core";
import { AnalysisModal, APP_SHELL_ID } from "./AnalysisModal";

describe("AnalysisModal accessibility", () => {
  it("has no critical axe violations for dialog semantics", async () => {
    // The modal portals to <body>, so scan baseElement rather than container.
    const { baseElement } = render(
      <AnalysisModal title="Sensitivity analysis" onCollapse={vi.fn()}>
        <button type="button">Close panel</button>
        <p>Analysis content</p>
      </AnalysisModal>
    );

    const results = await axe.run(baseElement, {
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

  it("does not steal focus when the parent re-renders with a new onCollapse", () => {
    // Regression: onCollapse used to be an effect dependency, and callers pass
    // an inline arrow. Every parent render tore down and re-ran the focus
    // effect, yanking the caret out of whatever the user was typing into.
    let bump!: () => void;

    function Parent() {
      const [n, setN] = useState(0);
      bump = () => setN((v) => v + 1);
      return (
        <AnalysisModal title="What-If" onCollapse={() => void n}>
          <button type="button">First focusable</button>
          <input aria-label="Lever value" defaultValue="10" />
        </AnalysisModal>
      );
    }

    const { getByLabelText } = render(<Parent />);
    const input = getByLabelText("Lever value") as HTMLInputElement;

    input.focus();
    expect(document.activeElement).toBe(input);

    act(() => bump());
    act(() => bump());

    expect(document.activeElement).toBe(input);
  });

  it("makes the app shell inert while open and restores it on close", () => {
    const shell = document.createElement("div");
    shell.id = APP_SHELL_ID;
    document.body.appendChild(shell);

    const { unmount } = render(
      <AnalysisModal title="Versions" onCollapse={vi.fn()}>
        <button type="button">Done</button>
      </AnalysisModal>
    );
    expect(shell.hasAttribute("inert")).toBe(true);

    unmount();
    expect(shell.hasAttribute("inert")).toBe(false);

    shell.remove();
  });
});
