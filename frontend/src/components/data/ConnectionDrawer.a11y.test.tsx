import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { ConnectionDrawer } from "./ConnectionDrawer";
import type { PlanningConnection } from "@/lib/api";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/api", () => ({
  createConnection: vi.fn(),
  updateConnection: vi.fn(),
  testConnectionDraft: vi.fn(),
}));

afterEach(cleanup);

const editConnection: PlanningConnection = {
  connection_id: "conn-1",
  workspace_id: "ws-1",
  provider: "anaplan",
  name: "Anaplan Prod",
  base_url: "https://api.anaplan.com/2/0",
  auth_kind: "oauth2_client_credentials",
  auth_public: {
    workspace_id: "8a81b09a12345678",
    token_url: "https://auth.anaplan.com/token/authenticate",
    client_id: "finance@example.com",
  },
  status: "active",
  last_test_at: null,
  last_test_ok: null,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

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

  it("allows selecting Anaplan and exposes accessible credential fields", async () => {
    const user = userEvent.setup();
    const view = render(<ConnectionDrawer open onClose={vi.fn()} onSaved={vi.fn()} />);

    const anaplan = view.getByRole("radio", { name: /Anaplan/ });
    expect(anaplan).toBeEnabled();
    await user.click(anaplan);

    expect(view.getByLabelText(/^Base URL/)).toHaveValue("https://api.anaplan.com/2/0");
    expect(view.getByLabelText(/^Workspace ID/)).toBeInTheDocument();
    expect(view.getByLabelText(/^Token URL/)).toHaveValue(
      "https://auth.anaplan.com/token/authenticate",
    );
    expect(view.getByLabelText(/^Username/)).toBeInTheDocument();
    expect(view.getByLabelText(/^Password/)).toBeInTheDocument();

    await user.click(view.getByLabelText("Use a pre-issued auth token"));
    expect(view.getByLabelText(/^AnaplanAuthToken value/)).toBeInTheDocument();
    expect(view.queryByLabelText(/^Username/)).not.toBeInTheDocument();
  });

  it("edit mode exposes Edit connection dialog name", async () => {
    render(
      <ConnectionDrawer
        open
        connection={editConnection}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    expect(screen.getByRole("dialog", { name: "Edit connection" })).toBeInTheDocument();
    expect(screen.getByLabelText(/^Workspace ID/)).toHaveValue("8a81b09a12345678");
    expect(screen.getByLabelText(/^Username/)).toHaveValue("finance@example.com");
  });

  it("marks validation errors with aria-invalid and passes axe", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <ConnectionDrawer open onClose={vi.fn()} onSaved={vi.fn()} />,
    );

    await user.click(screen.getByRole("button", { name: "Save connection" }));
    expect(screen.getByLabelText(/^Name/)).toHaveAttribute("aria-invalid", "true");
    expect(screen.getAllByRole("alert").length).toBeGreaterThan(0);

    const results = await axe.run(container, {
      rules: { "color-contrast": { enabled: false } },
    });
    const serious = results.violations.filter(
      (v) => v.impact === "critical" || v.impact === "serious",
    );
    expect(serious).toEqual([]);
  });

  it("supports arrow-key navigation across providers", async () => {
    const user = userEvent.setup();
    render(<ConnectionDrawer open onClose={vi.fn()} onSaved={vi.fn()} />);

    const sac = screen.getByRole("radio", { name: /SAP Analytics Cloud/ });
    sac.focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("radio", { name: /Mock \(demo\)/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });
});
