"use client";

import type { PlanningConnection } from "@/lib/api";

function statusChip(c: PlanningConnection): { label: string; className: string } {
  if (c.status === "disabled") {
    return { label: "Disabled", className: "bg-[var(--panel-bg)] text-[var(--text-muted)]" };
  }
  if (c.last_test_ok === true) {
    return { label: "Connected", className: "bg-[var(--success-bg)] text-[var(--success)]" };
  }
  if (c.last_test_ok === false) {
    return { label: "Failed", className: "bg-[var(--danger-bg)] text-[var(--danger)]" };
  }
  return { label: "Never tested", className: "bg-[var(--warning-bg)] text-[var(--warning)]" };
}

function relativeTime(iso: string | null): string | null {
  if (!iso) return null;
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  return `${Math.floor(diff / 86400_000)}d ago`;
}

const PROVIDER_LABELS: Record<string, string> = {
  sap_sac: "SAP Analytics Cloud",
  mock: "Mock (demo)",
  anaplan: "Anaplan",
  oracle_pbcs: "Oracle PBCS",
};

interface ConnectionCardProps {
  connection: PlanningConnection;
  selected?: boolean;
  isAdmin: boolean;
  onSelect: () => void;
  onTest: () => void;
  onEdit: () => void;
  onRemove: () => void;
  testing?: boolean;
}

export function ConnectionCard({
  connection,
  selected,
  isAdmin,
  onSelect,
  onTest,
  onEdit,
  onRemove,
  testing,
}: ConnectionCardProps) {
  const chip = statusChip(connection);
  const tested = relativeTime(connection.last_test_at);

  return (
    <div
      className={`rounded-xl border p-3 transition-all ${
        selected
          ? "border-accent bg-accent/5 ring-1 ring-accent/20"
          : "border-[var(--border)] bg-[var(--card-bg)] hover:border-[var(--panel-border)]"
      }`}
    >
      <button type="button" onClick={onSelect} className="w-full text-left">
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="flex items-center gap-2">
              <span
                className={`h-2 w-2 rounded-full ${
                  connection.last_test_ok === true
                    ? "bg-[var(--success)]"
                    : connection.last_test_ok === false
                      ? "bg-[var(--danger)]"
                      : "bg-[var(--text-muted)]"
                }`}
                aria-hidden="true"
              />
              <span className="text-sm font-semibold text-[var(--text-primary)]">{connection.name}</span>
            </div>
            <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">
              {PROVIDER_LABELS[connection.provider] || connection.provider}
            </p>
          </div>
          <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${chip.className}`}>
            {chip.label}
          </span>
        </div>
        {tested && (
          <p className="mt-1 text-[10px] text-[var(--text-muted)]">Tested {tested}</p>
        )}
      </button>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <button
          type="button"
          onClick={onTest}
          disabled={testing}
          className="rounded-lg border border-[var(--border)] px-2 py-1 text-[11px] font-medium text-[var(--text-secondary)] hover:bg-[var(--panel-bg)] disabled:opacity-40"
        >
          {testing ? "Testing…" : "Test"}
        </button>
        <button
          type="button"
          onClick={onSelect}
          className="rounded-lg border border-[var(--border)] px-2 py-1 text-[11px] font-medium text-[var(--text-secondary)] hover:bg-[var(--panel-bg)]"
        >
          Browse
        </button>
        {isAdmin && (
          <>
            <button
              type="button"
              onClick={onEdit}
              className="rounded-lg border border-[var(--border)] px-2 py-1 text-[11px] font-medium text-[var(--text-secondary)] hover:bg-[var(--panel-bg)]"
            >
              Edit
            </button>
            <button
              type="button"
              onClick={onRemove}
              className="rounded-lg border border-[var(--danger)]/30 px-2 py-1 text-[11px] font-medium text-[var(--danger)] hover:bg-[var(--danger-bg)]"
            >
              Remove
            </button>
          </>
        )}
      </div>
    </div>
  );
}
