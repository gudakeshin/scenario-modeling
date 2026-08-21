import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { WaterfallChart } from "./WaterfallChart";

vi.mock("recharts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("recharts")>();
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children?: unknown }) => (
      <div style={{ width: 600, height: 300 }}>{children as never}</div>
    ),
  };
});

/**
 * The real FY24 output of the Royal Enfield workbook. None of these ids is a
 * canonical P&L name, which is exactly the case that used to render a single
 * EBITDA bar: METRIC_ORDER intersected this map at one key.
 */
const workbookPl = {
  gross_revenue: 101003.16,
  less_trade_discounts_returns: 1010.02,
  net_revenue: 99993.14,
  material_vehicle_cost: 64495.58,
  gross_profit: 35497.56,
  total_opex: 252.14,
  ebitda: 35245.42,
  ebitda_margin: 0.3489,
};

const workbookBasePl = {
  gross_revenue: 101003.16,
  net_revenue: 99993.14,
  material_vehicle_cost: 59995.87,
  gross_profit: 39997.27,
  total_opex: 252.14,
  ebitda: 39745.13,
  ebitda_margin: 0.3935,
};

describe("WaterfallChart", () => {
  it("bridges a P&L that uses the workbook's own metric names", () => {
    render(<WaterfallChart pl={workbookPl} basePl={workbookBasePl} />);

    // Revenue, COGS, OpEx and EBITDA must all appear — not EBITDA alone.
    for (const label of ["Revenue", "COGS", "OpEx", "EBITDA"]) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
  });

  it("still bridges an already-canonical P&L", () => {
    render(
      <WaterfallChart
        pl={{ revenue: 1000, cogs: 600, opex: 200, ebitda: 200 }}
        basePl={{ revenue: 1000, cogs: 500, opex: 200, ebitda: 300 }}
      />,
    );
    for (const label of ["Revenue", "COGS", "OpEx", "EBITDA"]) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
  });
});
