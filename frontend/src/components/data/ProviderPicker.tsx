"use client";

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
    description: "Coming soon",
    available: false,
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
}

export function ProviderPicker({ value, onChange, disabled }: ProviderPickerProps) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2" role="radiogroup" aria-label="Provider">
      {PROVIDERS.map((p) => {
        const selected = value === p.id;
        const locked = disabled || !p.available;
        return (
          <button
            key={p.id}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={locked}
            onClick={() => onChange(p.id)}
            className={`text-left rounded-xl border px-3 py-3 transition-all ${
              selected
                ? "border-accent bg-accent/5 ring-1 ring-accent/30"
                : "border-[var(--border)] bg-[var(--card-bg)] hover:border-[var(--panel-border)]"
            } disabled:opacity-45 disabled:cursor-not-allowed`}
          >
            <div className="text-sm font-semibold text-[var(--text-primary)]">{p.name}</div>
            <div className="mt-0.5 text-[11px] text-[var(--text-muted)]">{p.description}</div>
          </button>
        );
      })}
    </div>
  );
}
