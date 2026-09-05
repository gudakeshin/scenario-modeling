"use client";

export interface StepperStep {
  id: string;
  label: string;
}

interface StepperProps {
  steps: StepperStep[];
  current: string;
  /** Completed step ids (checks shown). */
  completed?: string[];
}

export function Stepper({ steps, current, completed = [] }: StepperProps) {
  const currentIdx = steps.findIndex((s) => s.id === current);

  return (
    <ol className="flex flex-wrap items-center gap-2" aria-label="Progress">
      {steps.map((step, index) => {
        const isCurrent = step.id === current;
        const isDone = completed.includes(step.id) || (currentIdx > index && !isCurrent);
        return (
          <li key={step.id} className="flex items-center gap-2">
            {index > 0 && (
              <span className="hidden sm:block w-6 h-px bg-[var(--border)]" aria-hidden="true" />
            )}
            <span
              className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${
                isCurrent
                  ? "bg-accent/10 text-[var(--accent-text)] ring-1 ring-accent/30"
                  : isDone
                    ? "bg-[var(--success-bg)] text-[var(--success)]"
                    : "bg-[var(--panel-bg)] text-[var(--text-muted)]"
              }`}
              aria-current={isCurrent ? "step" : undefined}
            >
              <span
                className={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold ${
                  isCurrent
                    ? "bg-accent text-[var(--on-accent)]"
                    : isDone
                      ? "bg-[var(--success)] text-[var(--on-accent)]"
                      : "bg-[var(--border)] text-[var(--text-muted)]"
                }`}
              >
                {isDone ? "✓" : index + 1}
              </span>
              {step.label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
