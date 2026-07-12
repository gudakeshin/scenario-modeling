import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AttributionView } from "./AttributionView";
import type { AttributionResult } from "@/lib/api";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    runAttribution: vi.fn(),
  };
});

vi.mock("@/lib/metrics", () => ({
  fmtCurrency: (v: number) => `$${v}`,
  fmtCurrencySigned: (v: number) => (v < 0 ? `-$${Math.abs(v)}` : `+$${v}`),
  getCurrencySymbol: () => "$",
}));

vi.mock("recharts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("recharts")>();
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children?: unknown }) => (
      <div style={{ width: 400, height: 200 }}>{children as never}</div>
    ),
  };
});

import { runAttribution } from "@/lib/api";

const fixture: AttributionResult = {
  target_metric: "net_income",
  base_value: 100_000,
  scenario_value: 120_000,
  total_delta: 20_000,
  method: "shapley",
  bars: [
    { variable_id: "revenue", variable_name: "Revenue", contribution: 25_000 },
    { variable_id: "cogs", variable_name: "COGS", contribution: -5_000 },
  ],
};

describe("AttributionView", () => {
  beforeEach(() => {
    vi.mocked(runAttribution).mockResolvedValue(fixture);
  });

  it("renders driver contributions after run", async () => {
    const user = userEvent.setup();
    render(<AttributionView scenarioId="sc-1" onClose={() => {}} />);

    await user.click(screen.getByRole("button", { name: /run/i }));

    await waitFor(() => {
      expect(screen.getAllByText("Revenue").length).toBeGreaterThan(0);
      expect(screen.getAllByText("COGS").length).toBeGreaterThan(0);
    });
  });
});
