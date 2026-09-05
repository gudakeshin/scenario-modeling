import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { PanelMenu } from "./PanelMenu";
import { PANELS } from "@/lib/panels";

const analyzeItems = PANELS.filter((p) => p.group === "analyze" && !p.primary);

describe("PanelMenu accessibility", () => {
  it("has no critical axe violations when open", async () => {
    const user = userEvent.setup();
    const { baseElement } = render(
      <PanelMenu label="Analyze" items={analyzeItems} openPanels={[]} isLoading={false} onToggle={vi.fn()} />
    );

    await user.click(screen.getByRole("button", { name: /Analyze/ }));

    const results = await axe.run(baseElement, {
      rules: { "color-contrast": { enabled: false } },
    });
    const serious = results.violations.filter(
      (v) => v.impact === "critical" || v.impact === "serious"
    );
    expect(serious).toEqual([]);
  });

  it("announces expansion and per-item open state without changing labels", async () => {
    const user = userEvent.setup();
    render(
      <PanelMenu
        label="Analyze"
        items={analyzeItems}
        openPanels={["comparison"]}
        isLoading={false}
        onToggle={vi.fn()}
      />
    );

    const trigger = screen.getByRole("button", { name: /Analyze/ });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");

    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    // Label stays "Compare" whether open or closed — state rides on aria-checked.
    const compare = screen.getByRole("menuitemcheckbox", { name: "Compare" });
    expect(compare).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("menuitemcheckbox", { name: "Monte Carlo" })).toHaveAttribute(
      "aria-checked",
      "false"
    );
  });

  it("closes on Escape and returns focus to the trigger", async () => {
    const user = userEvent.setup();
    render(
      <PanelMenu label="Validate" items={analyzeItems} openPanels={[]} isLoading={false} onToggle={vi.fn()} />
    );

    const trigger = screen.getByRole("button", { name: /Validate/ });
    await user.click(trigger);
    expect(screen.getByRole("menu")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(trigger);
  });

  it("disables run-dependent items while a scenario is running", async () => {
    const user = userEvent.setup();
    render(
      <PanelMenu label="Analyze" items={analyzeItems} openPanels={[]} isLoading onToggle={vi.fn()} />
    );

    await user.click(screen.getByRole("button", { name: /Analyze/ }));
    expect(screen.getByRole("menuitemcheckbox", { name: "Compare" })).toBeDisabled();
  });
});
