/**
 * Single source of truth for the analysis panels.
 *
 * Panel identity, chip title, action-bar label, grouping, gating and colour all
 * live here so that the action bar (ChatContainer), the chip strip and the
 * expanded-panel switch (AnalysisPanelStrip) stay in lockstep instead of being
 * maintained as four parallel hand-written lists.
 */

export type PanelId =
  | "review"
  | "followUp"
  | "whatIf"
  | "goalSeek"
  | "comparison"
  | "monteCarlo"
  | "tornado"
  | "attribution"
  | "driverTree"
  | "periods"
  | "charts"
  | "insights"
  | "fidelity"
  | "versions"
  | "actuals"
  | "audit"
  | "sharing"
  | "templates"
  | "roles"
  | "documents"
  | "docManager";

/** Which action-bar cluster a panel belongs to. `null` = never in the action bar. */
export type PanelGroup = "refine" | "analyze" | "validate" | "manage" | null;

/** Extra state a panel needs before it can be opened at all. */
export type PanelRequirement = "none" | "scenario" | "periodData" | "chartData";

export interface PanelDef {
  id: PanelId;
  /** Chip title and the modal's accessible name. */
  title: string;
  /** Action-bar label. Stable — it never flips to "Hide …". */
  actionLabel: string;
  group: PanelGroup;
  /** Rendered as its own button rather than inside a group menu. */
  primary?: boolean;
  requires: PanelRequirement;
  /** Disabled while a scenario run is in flight. */
  disableWhileLoading: boolean;
  /** Tailwind background class for the chip's status dot. */
  dot: string;
}

export const PANELS: PanelDef[] = [
  // ── Refine ────────────────────────────────────────────────────────────────
  { id: "review", title: "Parameters", actionLabel: "Review Parameters", group: "refine", primary: true, requires: "scenario", disableWhileLoading: true, dot: "bg-accent" },
  { id: "followUp", title: "Refine Scenario", actionLabel: "Refine Scenario", group: null, requires: "scenario", disableWhileLoading: true, dot: "bg-accent" },
  { id: "whatIf", title: "What-If", actionLabel: "Live What-If", group: "refine", requires: "scenario", disableWhileLoading: true, dot: "bg-[var(--warning)]" },
  { id: "goalSeek", title: "Goal Seek", actionLabel: "Goal Seek", group: "refine", requires: "scenario", disableWhileLoading: true, dot: "bg-[var(--info)]" },

  // ── Analyze ───────────────────────────────────────────────────────────────
  { id: "comparison", title: "Comparison", actionLabel: "Compare", group: "analyze", requires: "scenario", disableWhileLoading: true, dot: "bg-[var(--info)]" },
  { id: "monteCarlo", title: "Monte Carlo", actionLabel: "Monte Carlo", group: "analyze", requires: "scenario", disableWhileLoading: true, dot: "bg-accent" },
  { id: "tornado", title: "Sensitivity", actionLabel: "Sensitivity", group: "analyze", requires: "scenario", disableWhileLoading: true, dot: "bg-[var(--warning)]" },
  { id: "attribution", title: "Attribution", actionLabel: "Attribution", group: "analyze", requires: "scenario", disableWhileLoading: true, dot: "bg-[var(--success)]" },
  { id: "driverTree", title: "Driver Tree", actionLabel: "Driver Tree", group: "analyze", requires: "scenario", disableWhileLoading: true, dot: "bg-accent" },
  { id: "periods", title: "Periods", actionLabel: "Periods", group: "analyze", requires: "periodData", disableWhileLoading: true, dot: "bg-accent" },
  { id: "charts", title: "Charts", actionLabel: "Charts", group: "analyze", requires: "chartData", disableWhileLoading: true, dot: "bg-accent" },

  // ── Insights (primary CTA) ────────────────────────────────────────────────
  { id: "insights", title: "Business Insights", actionLabel: "So What?", group: "analyze", primary: true, requires: "scenario", disableWhileLoading: true, dot: "bg-[var(--success)]" },

  // ── Validate ──────────────────────────────────────────────────────────────
  { id: "fidelity", title: "Fidelity", actionLabel: "Audit Fidelity", group: "validate", requires: "scenario", disableWhileLoading: true, dot: "bg-[var(--warning)]" },
  { id: "versions", title: "Versions", actionLabel: "Versions", group: "validate", requires: "scenario", disableWhileLoading: true, dot: "bg-accent" },
  { id: "actuals", title: "Actuals", actionLabel: "Actuals", group: "validate", requires: "scenario", disableWhileLoading: true, dot: "bg-[var(--success)]" },
  { id: "audit", title: "Audit Trail", actionLabel: "Audit Trail", group: "validate", requires: "none", disableWhileLoading: false, dot: "bg-[var(--text-muted)]" },

  // ── Manage ────────────────────────────────────────────────────────────────
  { id: "sharing", title: "Sharing", actionLabel: "Share", group: "manage", requires: "scenario", disableWhileLoading: true, dot: "bg-[var(--info)]" },
  { id: "templates", title: "Templates", actionLabel: "Templates", group: "manage", requires: "none", disableWhileLoading: false, dot: "bg-[var(--info)]" },
  { id: "roles", title: "Roles", actionLabel: "Roles", group: "manage", requires: "none", disableWhileLoading: false, dot: "bg-[var(--warning)]" },
  { id: "documents", title: "Documents", actionLabel: "Talk to Documents", group: "manage", requires: "none", disableWhileLoading: false, dot: "bg-[var(--info)]" },
  { id: "docManager", title: "Document Manager", actionLabel: "Document Manager", group: "manage", requires: "none", disableWhileLoading: false, dot: "bg-accent" },
];

const PANEL_BY_ID = new Map<PanelId, PanelDef>(PANELS.map((p) => [p.id, p]));

export function getPanel(id: PanelId): PanelDef | undefined {
  return PANEL_BY_ID.get(id);
}

export function panelTitle(id: PanelId): string {
  return PANEL_BY_ID.get(id)?.title ?? "Analysis panel";
}

export function panelDot(id: PanelId): string {
  return PANEL_BY_ID.get(id)?.dot ?? "bg-accent";
}

/** Action-bar group menus, in display order. */
export const PANEL_GROUPS: { id: Exclude<PanelGroup, null>; label: string }[] = [
  { id: "refine", label: "Refine" },
  { id: "analyze", label: "Analyze" },
  { id: "validate", label: "Validate" },
  { id: "manage", label: "Manage" },
];

export interface PanelAvailability {
  hasScenario: boolean;
  hasPeriodData: boolean;
  hasChartData: boolean;
}

/** Whether a panel's backing data exists. Panels that fail this are hidden, not disabled. */
export function isPanelAvailable(panel: PanelDef, a: PanelAvailability): boolean {
  switch (panel.requires) {
    case "scenario":
      return a.hasScenario;
    case "periodData":
      return a.hasPeriodData;
    case "chartData":
      return a.hasChartData;
    case "none":
      return true;
  }
}
