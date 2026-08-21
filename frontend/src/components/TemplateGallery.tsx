"use client";

import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { listTemplates, saveAsTemplate, cloneTemplate, type Template } from "@/lib/api";
import { PanelHeader } from "./PanelHeader";

interface TemplateGalleryProps {
  scenarioId?: string;
  onCloned?: (scenarioId: string) => void;
  onClose: () => void;
  onMinimize?: () => void;
}

function timeAgo(dateStr: string) {
  const d = new Date(dateStr);
  const diff = Date.now() - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export function TemplateGallery({ scenarioId, onCloned, onClose, onMinimize }: TemplateGalleryProps) {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showSave, setShowSave] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [saveDesc, setSaveDesc] = useState("");
  const [saveShared, setSaveShared] = useState(false);
  const [scope, setScope] = useState<string>("all");
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await listTemplates(scope === "all" ? undefined : scope);
      setTemplates(data);
      setLoadError(null);
    } catch (e) {
      setLoadError((e as Error).message || "Could not load templates.");
    }
    setLoading(false);
  }, [scope]);

  useEffect(() => { load(); }, [load]);

  const handleSave = useCallback(async () => {
    if (!scenarioId || !saveName.trim()) return;
    setSaving(true);
    try {
      await saveAsTemplate(scenarioId, saveName.trim(), saveDesc.trim() || undefined, saveShared);
      setShowSave(false);
      setSaveName("");
      setSaveDesc("");
      load();
      toast.success("Saved as template");
    } catch (e) {
      toast.error("Could not save template", { description: (e as Error).message });
    }
    setSaving(false);
  }, [scenarioId, saveName, saveDesc, saveShared, load]);

  const handleClone = useCallback(async (templateId: string) => {
    try {
      const { scenario_id } = await cloneTemplate(templateId);
      onCloned?.(scenario_id);
    } catch (e) {
      toast.error("Could not use template", { description: (e as Error).message });
    }
  }, [onCloned]);

  return (
    <div className="border-t border-[var(--border)] bg-background p-4 max-h-[60vh] overflow-auto">
      <PanelHeader
        title="Template Library"
        icon={<div className="w-5 h-5 rounded-md bg-[var(--info-bg)] flex items-center justify-center"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--info)" strokeWidth="2.5"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18M9 21V9" /></svg></div>}
        onClose={onClose}
        onMinimize={onMinimize || onClose}
        isMinimized={false}
        actions={
          scenarioId ? (
            <button
              onClick={() => setShowSave(!showSave)}
              className="rounded-lg border border-[var(--border)] px-3 py-1 text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--panel-bg)] transition-colors"
            >
              {showSave ? "Cancel" : "Save Current as Template"}
            </button>
          ) : undefined
        }
      />

      {loadError && (
        <div role="alert" className="mb-3 flex items-center justify-between gap-3 rounded-lg bg-[var(--danger-bg)] px-3 py-2 text-sm text-[var(--danger)]">
          <span>{loadError}</span>
          <button
            type="button"
            onClick={() => void load()}
            className="shrink-0 rounded-lg border border-[var(--danger)]/30 px-2.5 py-1 text-xs font-medium hover:bg-[var(--danger-bg)]"
          >
            Retry
          </button>
        </div>
      )}

      {/* Save form */}
      {showSave && (
        <div className="mb-4 p-3.5 rounded-xl bg-[var(--panel-bg)] border border-[var(--panel-border)] space-y-2.5">
          <input
            type="text"
            placeholder="Template name"
            value={saveName}
            onChange={(e) => setSaveName(e.target.value)}
            className="w-full rounded-lg border border-[var(--input-border)] bg-[var(--card-bg)] px-3 py-1.5 text-xs focus:outline-none focus:border-[var(--input-focus-border)] focus:ring-1 focus:ring-accent/20"
          />
          <input
            type="text"
            placeholder="Description (optional)"
            value={saveDesc}
            onChange={(e) => setSaveDesc(e.target.value)}
            className="w-full rounded-lg border border-[var(--input-border)] bg-[var(--card-bg)] px-3 py-1.5 text-xs focus:outline-none focus:border-[var(--input-focus-border)] focus:ring-1 focus:ring-accent/20"
          />
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)]">
              <input type="checkbox" checked={saveShared} onChange={(e) => setSaveShared(e.target.checked)} className="accent-[var(--accent)]" />
              Share with team
            </label>
            <button
              onClick={handleSave}
              disabled={saving || !saveName.trim()}
              className="rounded-lg bg-accent px-4 py-1.5 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-40 shadow-sm transition-colors"
            >
              {saving ? "Saving..." : "Save Template"}
            </button>
          </div>
        </div>
      )}

      {/* Scope filter */}
      <div className="flex gap-2 mb-3">
        {["all", "shared", "private"].map((s) => (
          <button
            key={s}
            onClick={() => setScope(s)}
            className={`rounded-full px-3 py-1 text-xs font-medium border transition-all ${
              scope === s
                ? "border-accent text-accent bg-accent/10"
                : "border-[var(--border)] text-[var(--text-muted)] hover:bg-[var(--panel-bg)]"
            }`}
          >
            {s.charAt(0).toUpperCase() + s.slice(1)}
          </button>
        ))}
      </div>

      {/* Template list */}
      {loading ? (
        <p className="text-xs text-[var(--text-faint)]">Loading templates...</p>
      ) : templates.length === 0 ? (
        <p className="text-xs text-[var(--text-faint)]">No templates found. Save a scenario as a template to get started.</p>
      ) : (
        <div className="grid gap-2">
          {templates.map((t) => (
            <div key={t.template_id} className="flex items-center justify-between p-3.5 rounded-xl border border-[var(--card-border)] bg-[var(--card-bg)] hover:shadow-card-hover transition-shadow">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold truncate text-[var(--text-primary)]">{t.name}</span>
                  {t.is_shared && (
                    <span className="rounded-full bg-accent/10 text-accent px-2 py-0.5 text-[10px] font-medium">Shared</span>
                  )}
                  <span className="text-[10px] text-[var(--text-faint)]">v{t.version}</span>
                </div>
                {t.description && (
                  <p className="text-[11px] text-[var(--text-muted)] truncate mt-0.5">{t.description}</p>
                )}
                <p className="text-[10px] text-[var(--text-faint)] mt-0.5">
                  {t.parameter_set.length} params · {timeAgo(t.created_at)}
                </p>
              </div>
              <button
                onClick={() => handleClone(t.template_id)}
                className="ml-3 rounded-lg border border-accent/30 bg-accent/5 px-3 py-1.5 text-xs font-medium text-accent hover:bg-accent/10 shrink-0 transition-colors"
              >
                Use Template
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
