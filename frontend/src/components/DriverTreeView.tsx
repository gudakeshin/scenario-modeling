"use client";

import { useState, useCallback, useEffect } from "react";
import { PanelHeader } from "./PanelHeader";
import {
  applyLeverValue,
  fetchDriverTree,
  getActiveModel,
  type DriverTreeNode,
  type DriverTreeResult,
} from "@/lib/api";
import { fmtMetric, pickDefaultTargetMetric, useCurrencyVersion } from "@/lib/metrics";

interface DriverTreeViewProps {
  scenarioId: string;
  onClose: () => void;
  onMinimize?: () => void;
}

function TreeNode({
  node,
  depth = 0,
  scenarioId,
  onApplied,
}: {
  node: DriverTreeNode;
  depth?: number;
  scenarioId: string;
  onApplied: () => void;
}) {
  const [open, setOpen] = useState(depth < 2);
  const [draft, setDraft] = useState(String(node.value));
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const hasChildren = !!node.children?.length;
  const dirty = node.editable && Number(draft) !== node.value && draft.trim() !== "";

  useEffect(() => {
    setDraft(String(node.value));
  }, [node.value]);

  const apply = async () => {
    const next = Number(draft);
    if (!Number.isFinite(next)) {
      setApplyError("Enter a finite number");
      return;
    }
    setApplying(true);
    setApplyError(null);
    try {
      await applyLeverValue(scenarioId, node.id, next, {
        delta_type: "absolute",
        reason: "driver_tree_edit",
        status: "pending",
      });
      onApplied();
    } catch (e) {
      setApplyError((e as Error).message);
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="select-none">
      <div
        className="flex w-full items-center gap-2 py-1.5 px-2 rounded-md hover:bg-[var(--panel-bg)]"
        style={{ paddingLeft: 8 + depth * 14 }}
      >
        <button
          type="button"
          onClick={() => hasChildren && setOpen((o) => !o)}
          className="w-3 text-[10px] text-[var(--text-faint)] shrink-0 text-left"
          aria-label={hasChildren ? (open ? "Collapse" : "Expand") : undefined}
        >
          {hasChildren ? (open ? "▼" : "▶") : "·"}
        </button>
        <span className="text-xs text-[var(--text-primary)] flex-1 truncate">{node.name}</span>
        {node.editable ? (
          <div className="flex items-center gap-1 shrink-0">
            <input
              type="number"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              className="w-24 rounded border border-[var(--input-border)] bg-[var(--card-bg)] px-1.5 py-0.5 text-xs tabular-nums text-right"
              aria-label={`Edit ${node.name}`}
            />
            <button
              type="button"
              disabled={!dirty || applying}
              onClick={() => void apply()}
              className="rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium text-accent disabled:opacity-40"
            >
              {applying ? "…" : "Apply"}
            </button>
          </div>
        ) : (
          <span className="text-xs font-medium text-[var(--text-secondary)] tabular-nums">
            {fmtMetric(node.id, node.value, node.name)}
          </span>
        )}
      </div>
      {applyError && (
        <p className="text-[10px] text-[var(--danger)] px-2" style={{ paddingLeft: 24 + depth * 14 }}>
          {applyError}
        </p>
      )}
      {open &&
        hasChildren &&
        node.children!.map((child) => (
          <TreeNode
            key={child.id}
            node={child}
            depth={depth + 1}
            scenarioId={scenarioId}
            onApplied={onApplied}
          />
        ))}
    </div>
  );
}

export function DriverTreeView({ scenarioId, onClose, onMinimize }: DriverTreeViewProps) {
  useCurrencyVersion();
  const [result, setResult] = useState<DriverTreeResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [metric, setMetric] = useState("");
  const [metricReady, setMetricReady] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [reason, setReason] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getActiveModel()
      .then(({ model }) => {
        if (cancelled) return;
        const ids = (model?.model_definition?.variables ?? [])
          .filter((v) => v.tags?.includes("pl_metric") || v.tags?.includes("output") || (v.dependencies?.length ?? 0) > 0)
          .map((v) => v.id);
        setMetric(pickDefaultTargetMetric(ids, "net_income"));
        setMetricReady(true);
      })
      .catch(() => {
        if (cancelled) return;
        setMetric(pickDefaultTargetMetric([], "ebitda"));
        setMetricReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const load = useCallback(async () => {
    if (!metric) return;
    setLoading(true);
    setError(null);
    try {
      const tree = await fetchDriverTree(scenarioId, metric, { reason });
      setResult(tree);
      setNotice(
        tree.target_metric && tree.target_metric !== metric
          ? `Model has no “${metric}”; showing ${tree.target_metric}.`
          : null,
      );
    } catch (e) {
      setError((e as Error).message);
    }
    setLoading(false);
  }, [scenarioId, metric, reason]);

  useEffect(() => {
    if (!metricReady || !metric) return;
    void load();
  }, [metricReady, load]);

  return (
    <div className="border-t border-[var(--border)] bg-background p-4 max-h-[60vh] overflow-auto">
      <PanelHeader
        title="Driver Tree"
        icon={
          <div className="w-5 h-5 rounded-md bg-accent/10 flex items-center justify-center">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2.5">
              <path d="M12 3v6M12 15v6M6 9h12M6 15h12M6 9v6M18 9v6" />
            </svg>
          </div>
        }
        onClose={onClose}
        onMinimize={onMinimize || onClose}
        isMinimized={false}
      />

      <div className="flex items-center gap-3 mb-3 bg-[var(--panel-bg)] rounded-xl border border-[var(--panel-border)] p-3">
        <label className="text-xs text-[var(--text-muted)]">
          Metric:
          <input
            value={metric}
            onChange={(e) => setMetric(e.target.value)}
            className="ml-1.5 w-32 rounded-lg border border-[var(--input-border)] bg-[var(--card-bg)] px-2 py-1 text-xs"
          />
        </label>
        <label className="text-xs text-[var(--text-muted)] flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={reason}
            onChange={(e) => setReason(e.target.checked)}
          />
          LLM restructure
        </label>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="rounded-lg bg-accent px-4 py-1.5 text-xs font-medium text-white disabled:opacity-40"
        >
          {loading ? "Loading..." : "Refresh"}
        </button>
      </div>

      {error && <p className="text-xs text-[var(--danger)] mb-2 bg-[var(--danger-bg)] px-3 py-1.5 rounded-lg">{error}</p>}
      {notice && <p className="text-xs text-accent mb-2 px-1">{notice}</p>}
      {result?.rationale && (
        <p className="text-xs text-[var(--text-secondary)] mb-2 px-1 italic">{result.rationale}</p>
      )}
      {result?.reconciliation && !result.reconciliation.ok && (
        <p className="text-xs text-[var(--warning)] mb-2 px-1">
          LLM tree failed reconciliation — showing deterministic tree.
        </p>
      )}

      {result && (
        <div className="rounded-xl border border-[var(--panel-border)] bg-[var(--card-bg)] p-2">
          <p className="text-[10px] uppercase tracking-wider text-[var(--text-faint)] px-2 mb-1">
            {result.model_kind} · {result.target_metric}
            {result.apply_path ? ` · ${result.apply_path}` : ""}
          </p>
          <TreeNode
            node={result.root}
            scenarioId={scenarioId}
            onApplied={() => {
              setNotice("Lever queued as pending — approve in Parameter Review to run.");
              void load();
            }}
          />
        </div>
      )}
    </div>
  );
}
