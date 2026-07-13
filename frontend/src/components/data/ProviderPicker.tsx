"use client";

import type { KeyboardEvent } from "react";

export type ProviderId = "sap_sac" | "mock" | "anaplan" | "oracle_pbcs";

const PROVIDERS: Array<{
  id: ProviderId;
  name: string;
  description: string;
  available: boolean;
}> = [
  {
    id: "sap_sac",
    name: "SAP Analytics Cloud",
    description: "OAuth client credentials · Data Export Service",
    available: true,
  },
  {
    id: "mock",
    name: "Mock (demo)",
    description: "Fixture-backed connector for demos and CI",
    available: true,
  },
  {
    id: "anaplan",
    name: "Anaplan",
    description: "Username & password · Cell data API",
    available: true,
  },
  {
    id: "oracle_pbcs",
    name: "Oracle PBCS",
    description: "Coming soon",
    available: false,
  },
];

interface ProviderPickerProps {
  value: string;
  onChange: (provider: ProviderId) => void;
  disabled?: boolean;
  "aria-labelledby"?: string;
}

export function ProviderPicker({
  value,
  onChange,
  disabled,
  "aria-labelledby": ariaLabelledBy,
}: ProviderPickerProps) {
  const enabled = PROVIDERS.filter((provider) => provider.available && !disabled);

  const moveSelection = (currentId: string, delta: number) => {
    if (enabled.length === 0) return;
    const index = Math.max(0, enabled.findIndex((provider) => provider.id === currentId));
    const next = enabled[(index + delta + enabled.length) % enabled.length];
    onChange(next.id);
    document.getElementById(`provider-${next.id}`)?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, providerId: ProviderId) => {
    if (disabled) return;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault();
      moveSelection(providerId, 1);
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault();
      moveSelection(providerId, -1);
    } else if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      onChange(providerId);
    }
  };

  return (
    <div
      className="grid grid-cols-1 sm:grid-cols-2 gap-2"
      role="radiogroup"
      {...(ariaLabelledBy
        ? { "aria-labelledby": ariaLabelledBy }
        : { "aria-label": "Provider" })}
    >
      {PROVIDERS.map((provider) => {
        const selected = value === provider.id;
        const locked = disabled || !provider.available;
        return (
          <button
            key={provider.id}
            id={`provider-${provider.id}`}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={locked}
            tabIndex={locked ? -1 : selected || (!enabled.some((item) => item.id === value) && provider.id === enabled[0]?.id) ? 0 : -1}
            onClick={() => onChange(provider.id)}
            onKeyDown={(event) => onKeyDown(event, provider.id)}
            className={`text-left rounded-xl border px-3 py-3 transition-all ${
              selected
                ? "border-accent bg-accent/5 ring-1 ring-accent/30"
                : "border-[var(--border)] bg-[var(--card-bg)] hover:border-[var(--panel-border)]"
            } disabled:opacity-45 disabled:cursor-not-allowed`}
          >
            <div className="text-sm font-semibold text-[var(--text-primary)]">{provider.name}</div>
            <div className="mt-0.5 text-[11px] text-[var(--text-muted)]">{provider.description}</div>
          </button>
        );
      })}
    </div>
  );
}
