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

  it("does not render Gross Margin's percentage as a currency bar equal to Revenue", () => {
    // Regression: a model with no bare "cogs" key (e.g. a compound id like
    // "p_l_cost_of_goods_sold") plus a `gross_margin` *fraction* (0.5695,
    // i.e. 56.95%) used to feed straight into the waterfall's `value -
    // running` step. With no COGS bar to shrink `running` first, that left
    // `running` at Revenue, so the bar showed ~(0.57 - revenue) ≈ -revenue —
    // Revenue and "Gross Margin" reading as the same magnitude on the chart.
    render(
      <WaterfallChart
        pl={{
          revenue: 28488.4632,
          p_l_cost_of_goods_sold: 12264.283408,
          gross_margin: 0.5695,
          gross_profit: 16224.179792,
          total_operating_expenses: 10157.000108,
          ebitda: 6539.6796844,
        }}
      />,
    );
    expect(screen.queryByText("Gross Margin")).not.toBeInTheDocument();
    expect(screen.getAllByText("Gross Profit").length).toBeGreaterThan(0);
  });

  it("shows an explanatory empty state for a model with no canonical P&L ids", () => {
    // A bare dimensional model (e.g. just "amount"/"units", no Revenue/COGS/
    // OpEx/EBITDA breakdown) intersects METRIC_ORDER at nothing. Previously
    // this rendered an empty Recharts <BarChart> — a blank box with no
    // explanation, which reads as "the chart is broken" rather than "this
    // model has no waterfall-shaped data".
    render(<WaterfallChart pl={{ amount: 718300, units: 350 }} />);
    expect(screen.getByText(/No standard P&L bridge/)).toBeInTheDocument();
    expect(screen.getByText(/amount, units/)).toBeInTheDocument();
  });
});
