import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import axe from "axe-core";
import { ConnectionDrawer } from "./ConnectionDrawer";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/api", () => ({
  createConnection: vi.fn(),
  updateConnection: vi.fn(),
  testConnectionDraft: vi.fn(),
}));

describe("ConnectionDrawer accessibility", () => {
  it("exposes dialog role and accessible name", async () => {
    const { container } = render(
      <ConnectionDrawer open onClose={vi.fn()} onSaved={vi.fn()} />,
    );

    expect(screen.getByRole("dialog", { name: "Connect a system" })).toHaveAttribute(
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
});
