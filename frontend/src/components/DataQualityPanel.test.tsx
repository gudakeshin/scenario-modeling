import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DataQualityFindings } from "./DataQualityPanel";
import type { DataQualityReport } from "@/lib/api";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    getDataQuality: vi.fn(),
    acknowledgeDataQualityFinding: vi.fn(),
  };
});

import { getDataQuality, acknowledgeDataQualityFinding } from "@/lib/api";

const blocking = {
  findingKey: "abc123",
  code: "period_outlier" as const,
  severity: "error" as const,
  title: "A period is far out of line with the rest of its row",
  message:
    '"Bullet" on Volume_Plan: C4=6,00,000, D4=63,00,000 against a median of 54,411 across 12 periods.',
  sheet: "Volume_Plan",
  cells: ["C4", "D4"],
  status: "open" as const,
};

const informational = {
  findingKey: "def456",
  code: "calendar_mismatch" as const,
  severity: "warning" as const,
  title: "A sheet is on a different year than the reported periods",
  message: "Results are reported on P&L's 2024 calendar, but Volume_Plan is on 2023.",
  sheet: "Volume_Plan",
  cells: [],
  status: "open" as const,
};

const report: DataQualityReport = {
  document_id: "doc-1",
  findings: [blocking, informational],
  blocking: [blocking],
  counts: { total: 2, open: 2, blocking: 1 },
};

describe("DataQualityFindings", () => {
  beforeEach(() => {
    vi.mocked(getDataQuality).mockResolvedValue(report);
    vi.mocked(acknowledgeDataQualityFinding).mockResolvedValue({
      acknowledged: true,
      finding: { ...blocking, status: "acknowledged", note: "Known bad source extract" },
    });
  });

  it("separates what blocks a run from what is merely worth knowing", async () => {
    render(<DataQualityFindings />);

    await waitFor(() => {
      expect(screen.getByText(/Needs a decision before this model can run/)).toBeInTheDocument();
    });
    expect(screen.getByText(/Worth knowing/)).toBeInTheDocument();
    // The offending cells are named, so the user can go look at them.
    expect(screen.getByText(/Volume_Plan!C4, D4/)).toBeInTheDocument();
  });

  it("requires a reason before a finding can be accepted", async () => {
    const user = userEvent.setup();
    render(<DataQualityFindings />);

    await waitFor(() => expect(screen.getAllByRole("button", { name: /accept/i })).toHaveLength(2));
    const [acceptBlocking] = screen.getAllByRole("button", { name: /accept/i });
    expect(acceptBlocking).toBeDisabled();

    const [noteField] = screen.getAllByPlaceholderText(/Why is this acceptable/);
    await user.type(noteField, "Known bad source extract");
    expect(acceptBlocking).toBeEnabled();

    await user.click(acceptBlocking);
    await waitFor(() => {
      expect(acknowledgeDataQualityFinding).toHaveBeenCalledWith(
        "abc123",
        "Known bad source extract",
      );
    });
  });

  it("says so plainly when the workbook is clean", async () => {
    vi.mocked(getDataQuality).mockResolvedValue({
      document_id: "doc-1",
      findings: [],
      blocking: [],
      counts: { total: 0, open: 0, blocking: 0 },
    });
    render(<DataQualityFindings />);
    await waitFor(() => {
      expect(screen.getByText(/No data issues found/)).toBeInTheDocument();
    });
  });
});
