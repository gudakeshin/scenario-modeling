import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const h = vi.hoisted(() => {
  const doc = (id: string, name: string) => ({
    document_id: id,
    name,
    original_filename: name,
    file_type: "pdf",
    file_size_bytes: 10,
    chunk_count: 1,
    status: "ready",
    created_at: "2026-01-01T00:00:00Z",
  });
  return {
    deleteDocument: vi.fn().mockResolvedValue(undefined),
    docs: [doc("d1", "budget.pdf"), doc("d2", "plan.xlsx")],
  };
});

vi.mock("@/lib/api", () => ({
  uploadDocument: vi.fn(),
  listDocuments: vi.fn().mockResolvedValue(h.docs),
  deleteDocument: h.deleteDocument,
  getCompanyContext: vi.fn().mockResolvedValue({ context: null, model_intelligence: null }),
  buildContext: vi.fn(),
  deleteCompanyContext: vi.fn(),
  getActiveModel: vi.fn().mockResolvedValue({ model: null }),
  updateActiveModel: vi.fn(),
  validateModelSchema: vi.fn(),
  getDataQuality: vi.fn().mockResolvedValue({ findings: [] }),
  acknowledgeDataQualityFinding: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

import { DocumentManager } from "./DocumentManager";

describe("DocumentManager destructive actions", () => {
  beforeEach(() => h.deleteDocument.mockClear());
  // vitest runs without globals, so RTL cannot register auto-cleanup itself.
  afterEach(cleanup);

  it("does not delete anything until Clear All is confirmed", async () => {
    const user = userEvent.setup();
    render(<DocumentManager onClose={vi.fn()} />);

    await screen.findByText("budget.pdf");
    await user.click(screen.getByRole("button", { name: "Clear All" }));

    // A confirm dialog appears, naming the count — and nothing is deleted yet.
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Delete all 2 documents?");
    expect(h.deleteDocument).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(h.deleteDocument).not.toHaveBeenCalled();
  });

  it("deletes every document once confirmed", async () => {
    const user = userEvent.setup();
    render(<DocumentManager onClose={vi.fn()} />);

    await screen.findByText("budget.pdf");
    await user.click(screen.getByRole("button", { name: "Clear All" }));
    await user.click(await screen.findByRole("button", { name: "Delete all 2" }));

    await waitFor(() => expect(h.deleteDocument).toHaveBeenCalledTimes(2));
    expect(h.deleteDocument).toHaveBeenCalledWith("d1");
    expect(h.deleteDocument).toHaveBeenCalledWith("d2");
  });

  it("opens the file picker when the drop zone itself is activated", async () => {
    const user = userEvent.setup();
    render(<DocumentManager onClose={vi.fn()} />);

    const zone = await screen.findByRole("button", {
      name: /drag and drop files here/i,
    });
    const input = zone.querySelector('input[type="file"]') as HTMLInputElement;
    const click = vi.spyOn(input, "click").mockImplementation(() => {});

    // The copy promises "click to browse" — the zone must honour it.
    await user.click(zone);
    expect(click).toHaveBeenCalled();

    // …and be reachable from the keyboard.
    click.mockClear();
    zone.focus();
    await user.keyboard("{Enter}");
    expect(click).toHaveBeenCalled();
  });
});
