import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import axe from "axe-core";
import { ImportWizard } from "./ImportWizard";

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock("@/lib/api", () => ({
  getActiveModel: vi.fn(async () => ({ model: null })),
  getPlanningModelMetadata: vi.fn(async () => ({
    modelId: "m1",
    modelName: "Demo Model",
    dimensions: [
      {
        id: "time",
        name: "Time",
        type: "time",
        members: [
          { id: "2024.01", name: "2024.01", parentId: null, isLeaf: true, ordinal: 0 },
          { id: "2024.02", name: "2024.02", parentId: null, isLeaf: true, ordinal: 1 },
        ],
      },
      {
        id: "version",
        name: "Version",
        type: "version",
        members: [{ id: "actual", name: "Actual", parentId: null, isLeaf: true, ordinal: 0 }],
      },
    ],
    measures: [
      { id: "revenue", name: "Revenue" },
      { id: "cogs", name: "COGS" },
    ],
  })),
  getModelMappingPreview: vi.fn(async () => ({
    model_id: "m1",
    model_name: "Demo Model",
    measures: [
      { id: "revenue", name: "Revenue", role: "input" },
      { id: "cogs", name: "COGS", role: "input" },
    ],
    account_signage: false,
    notes: [],
  })),
  importPlanningModel: vi.fn(),
  getImportStatus: vi.fn(),
  cancelImport: vi.fn(),
}));

describe("ImportWizard accessibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders scope step as dialog with no critical axe violations", async () => {
    const { container } = render(
      <ImportWizard
        open
        connectionId="c1"
        modelId="m1"
        modelName="Demo Model"
        onClose={vi.fn()}
        onComplete={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: "Import model" })).toBeTruthy();
    });

    await waitFor(() => {
      expect(screen.getByText(/Estimated cells/i)).toBeTruthy();
    });

    const results = await axe.run(container, {
      rules: { "color-contrast": { enabled: false } },
    });
    const serious = results.violations.filter(
      (v) => v.impact === "critical" || v.impact === "serious",
    );
    expect(serious).toEqual([]);
  });
});
