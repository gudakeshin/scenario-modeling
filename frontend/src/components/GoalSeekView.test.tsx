import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GoalSeekView } from "./GoalSeekView";
import type { GoalSeekResult } from "@/lib/api";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    getActiveModel: vi.fn().mockResolvedValue({
      model: {
        model_definition: {
          variables: [
            { id: "revenue", name: "Revenue", dependencies: [], tags: ["input"] },
            {
              id: "net_income",
              name: "Net Income",
              dependencies: ["revenue"],
              tags: ["output", "pl_metric"],
            },
          ],
        },
      },
    }),
    runGoalSeek: vi.fn(),
    applyLeverValue: vi.fn(),
  };
});

vi.mock("@/lib/metrics", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/metrics")>();
  return {
    ...actual,
    fmtCurrency: (v: number) => `$${v}`,
  };
});

import { runGoalSeek, applyLeverValue } from "@/lib/api";

const fixture: GoalSeekResult = {
  variable_id: "revenue",
  target_metric: "net_income",
  target_value: 50_000,
  solved_value: 120_000,
  achieved_metric: 50_000,
  iterations: 12,
  converged: true,
  diagnostics: { method: "bisection" },
};

describe("GoalSeekView", () => {
  beforeEach(() => {
    vi.mocked(runGoalSeek).mockResolvedValue(fixture);
    vi.mocked(applyLeverValue).mockResolvedValue({
      parameter_id: "p1",
      mapped_variable_id: "revenue",
      scenario_value: 120_000,
      delta_type: "absolute",
      status: "pending",
      created: true,
    });
  });

  it("solves and offers apply-to-parameters", async () => {
    const user = userEvent.setup();
    render(<GoalSeekView scenarioId="sc-1" onClose={() => {}} />);

    // loadLevers() runs on lever-select focus and sets the default target metric
    await user.click(screen.getByRole("combobox"));
    await waitFor(() => {
      expect(screen.getByRole("option", { name: "Net Income", selected: true })).toBeInTheDocument();
    });

    const targetInput = screen.getByRole("spinbutton");
    await user.clear(targetInput);
    await user.type(targetInput, "50000");

    await user.click(screen.getByRole("button", { name: /solve/i }));

    await waitFor(() => {
      expect(runGoalSeek).toHaveBeenCalledWith("sc-1", "revenue", 50000, "net_income");
      expect(screen.getByText(/Converged/i)).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /apply to parameters/i }));

    await waitFor(() => {
      expect(applyLeverValue).toHaveBeenCalledWith(
        "sc-1",
        "revenue",
        120_000,
        expect.objectContaining({ delta_type: "absolute", status: "pending" }),
      );
      expect(screen.getByText(/Created pending parameter for revenue/i)).toBeInTheDocument();
    });
  });
});
