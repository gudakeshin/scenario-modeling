import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TornadoChart } from "./TornadoChart";
import type { SensitivityResult } from "@/lib/api";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    getActiveModel: vi.fn().mockResolvedValue({
      model: {
        model_definition: {
          variables: [
            { id: "revenue_growth", name: "Revenue Growth", dependencies: [], tags: ["input"] },
            { id: "cogs_pct", name: "COGS %", dependencies: [], tags: ["input"] },
            {
              id: "net_income",
              name: "Net Income",
              dependencies: ["revenue_growth"],
              tags: ["output", "pl_metric"],
            },
          ],
        },
      },
    }),
    runSensitivity: vi.fn(),
  };
});

vi.mock("@/lib/metrics", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/metrics")>();
  return {
    ...actual,
    fmtCurrency: (v: number) => `$${v}`,
    fmtCurrencySigned: (v: number) => (v < 0 ? `-$${Math.abs(v)}` : `+$${v}`),
    getCurrencySymbol: () => "$",
  };
});

vi.mock("recharts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("recharts")>();
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children?: unknown }) => (
      <div style={{ width: 400, height: 200 }}>{children as never}</div>
    ),
  };
});

import { runSensitivity } from "@/lib/api";

const fixture: SensitivityResult = {
  target_metric: "net_income",
  swing_pct: 20,
  base_metric_value: 100_000,
  bars: [
    {
      variable_id: "revenue_growth",
      variable_name: "Revenue Growth",
      low_value: 0.05,
      high_value: 0.15,
      base_value: 0.1,
      low_delta: -20_000,
      high_delta: 25_000,
      spread: 45_000,
    },
    {
      variable_id: "cogs_pct",
      variable_name: "COGS %",
      low_value: 0.4,
      high_value: 0.6,
      base_value: 0.5,
      low_delta: -10_000,
      high_delta: 12_000,
      spread: 22_000,
    },
  ],
};

describe("TornadoChart", () => {
  beforeEach(() => {
    vi.mocked(runSensitivity).mockResolvedValue(fixture);
  });

  it("renders variable labels after running analysis", async () => {
    const user = userEvent.setup();
    render(<TornadoChart scenarioId="sc-1" onClose={() => {}} />);

    // Await async default target-metric selection from getActiveModel
    await waitFor(() => {
      expect(screen.getByRole("option", { name: "Net Income", selected: true })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /run analysis/i }));

    await waitFor(() => {
      expect(screen.getAllByText("Revenue Growth").length).toBeGreaterThan(0);
      expect(screen.getAllByText("COGS %").length).toBeGreaterThan(0);
    });

    expect(screen.getByText(/Variable Impact Ranking/i)).toBeInTheDocument();
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(runSensitivity).toHaveBeenCalledWith("sc-1", "net_income", 20);
  });
});
