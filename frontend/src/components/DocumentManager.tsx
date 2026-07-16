"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { PanelHeader } from "./PanelHeader";
import {
  uploadDocument,
  listDocuments,
  deleteDocument,
  getCompanyContext,
  buildContext,
  deleteCompanyContext,
  getActiveModel,
  updateActiveModel,
  validateModelSchema,
  type DocumentRecord,
  type CompanyContext,
  type UserModel,
  type IngestionReport,
  type FidelityReport,
} from "@/lib/api";
import { getCurrencySymbol } from "@/lib/metrics";
import { useUiStore } from "@/stores/uiStore";

type Tab = "documents" | "context" | "model";

interface Props {
  onClose: () => void;
  onMinimize?: () => void;
  onContextBuilt?: () => void;
}

function kindLabel(kind?: string) {
  if (kind === "spreadsheet_model") return "XLSX model";
  if (kind === "tabular_data") return "Tabular data";
  return "Document";
}

function ingestionSummary(doc: DocumentRecord): string | null {
  const r = doc.ingestion_report as IngestionReport | null | undefined;
  if (!r?.summary) {
    if (doc.document_kind === "tabular_data") return "CSV data-only (no formulas)";
    return null;
  }
  return r.summary;
}

export function DocumentManager({ onClose, onMinimize, onContextBuilt }: Props) {
  const docManagerInitialTab = useUiStore((s) => s.docManagerInitialTab);
  const setDocManagerInitialTab = useUiStore((s) => s.setDocManagerInitialTab);
  const [tab, setTab] = useState<Tab>(docManagerInitialTab || "documents");
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [context, setContext] = useState<CompanyContext | null>(null);
  const [modelValidationStatus, setModelValidationStatus] = useState<"processing" | "needs_validation" | "ready" | null>(null);
  const [ingestionReport, setIngestionReport] = useState<IngestionReport | null>(null);
  const [fidelityReport, setFidelityReport] = useState<FidelityReport | null>(null);
  const [model, setModel] = useState<UserModel | null>(null);
  const [building, setBuilding] = useState(false);
  const [buildError, setBuildError] = useState<string | null>(null);
  const [validating, setValidating] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [editingVar, setEditingVar] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!docManagerInitialTab) return;
    setTab(docManagerInitialTab);
    setDocManagerInitialTab(null);
  }, [docManagerInitialTab, setDocManagerInitialTab]);

  const loadDocuments = useCallback(async () => {
    try { setDocuments(await listDocuments()); } catch { /* ignore */ }
  }, []);

  const loadContext = useCallback(async () => {
    try {
      const { context: ctx, model_intelligence } = await getCompanyContext();
      setContext(ctx);
      setModelValidationStatus(model_intelligence?.validation_status || null);
      setIngestionReport(
        (model_intelligence?.ingestion_report as IngestionReport | null | undefined) ||
          (ctx?.context_data?.ingestion_report as IngestionReport | null | undefined) ||
          null,
      );
      const fidelity =
        (ctx?.context_data?.runtime_validation?.fidelity as FidelityReport | undefined) || null;
      setFidelityReport(fidelity);
    } catch { /* ignore */ }
  }, []);

  const loadModel = useCallback(async () => {
    try {
      const { model: m } = await getActiveModel();
      setModel(m);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { loadDocuments(); loadContext(); loadModel(); }, [loadDocuments, loadContext, loadModel]);

  const handleUpload = async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (list.length === 0) return;

    setUploading(true);
    setUploadError(null);
    setUploadProgress(null);

    const failures: string[] = [];
    for (let i = 0; i < list.length; i++) {
      const file = list[i];
      setUploadProgress(`Uploading ${i + 1} of ${list.length}: ${file.name}`);
      try {
        await uploadDocument(file);
      } catch (e) {
        failures.push(`${file.name}: ${(e as Error).message}`);
      }
    }

    await loadDocuments();
    setUploadProgress(null);
    setUploading(false);
    if (failures.length > 0) {
      setUploadError(
        failures.length === list.length
          ? failures.join("\n")
          : `${failures.length} of ${list.length} failed:\n${failures.join("\n")}`
      );
    }
  };

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files.length > 0) {
      void handleUpload(e.dataTransfer.files);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- handleUpload closes over latest state setters
  }, []);

  const handleDelete = async (docId: string) => {
    try {
      await deleteDocument(docId);
      await loadDocuments();
    } catch { /* ignore */ }
  };

  const handleDeleteAll = async () => {
    for (const doc of documents) {
      try { await deleteDocument(doc.document_id); } catch { /* ignore */ }
    }
    await loadDocuments();
  };

  const handleBuildContext = async () => {
    setBuilding(true);
    setBuildError(null);
    try {
      const ctx = await buildContext();
      setContext(ctx);
      await loadModel();
      setTab("context");
      onContextBuilt?.();
    } catch (e) {
      setBuildError((e as Error).message);
    }
    setBuilding(false);
  };

  const handleResetContext = async () => {
    try {
      await deleteCompanyContext();
      setContext(null);
      setModel(null);
    } catch { /* ignore */ }
  };

  const handleValidateModel = async () => {
    try {
      setValidating(true);
      setBuildError(null);
      // Validation requires model_schema from context build — run it first when missing.
      if (!context?.context_data?.model_schema) {
        const ctx = await buildContext();
        setContext(ctx);
        await loadModel();
      }
      const latestSpreadsheet = documents.find((d) => d.document_kind === "spreadsheet_model");
      const result = await validateModelSchema(latestSpreadsheet?.document_id);
      if (result.fidelity) setFidelityReport(result.fidelity);
      await loadContext();
      await loadDocuments();
      setTab("context");
      onContextBuilt?.();
    } catch (e) {
      const err = e as Error & { fidelity?: FidelityReport };
      if (err.fidelity) setFidelityReport(err.fidelity);
      setBuildError(err.message);
      await loadContext();
      setTab("context");
    } finally {
      setValidating(false);
    }
  };

  const handleUpdateVariable = async (varId: string, field: string, value: string) => {
    if (!model) return;
    const updated = {
      ...model.model_definition,
      variables: model.model_definition.variables.map((v) =>
        v.id === varId ? { ...v, [field]: field === "formula" ? value : value } : v
      ),
    };
    try {
      const result = await updateActiveModel(updated);
      setModel(result.model);
      setEditingVar(null);
    } catch { /* ignore */ }
  };

  const tabBtn = (t: Tab, label: string) => (
    <button
      type="button"
      onClick={() => setTab(t)}
      className={`px-4 py-2 text-sm font-medium rounded-t-lg border-b-2 transition-all ${
        tab === t
          ? "border-accent text-accent bg-accent/5"
          : "border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--panel-bg)]"
      }`}
    >
      {label}
    </button>
  );

  const readyDocs = documents.filter((d) => d.status === "ready").length;

  const validationPill = (status?: "processing" | "needs_validation" | "ready" | "error") => {
    if (!status) return null;
    if (status === "ready") return <span className="text-[10px] px-2 py-0.5 rounded-full bg-[var(--success)]/15 text-[var(--success)] border border-[var(--success)]/20">Model Intelligence Ready</span>;
    if (status === "needs_validation") return <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-600 border border-amber-500/20">Needs Validation</span>;
    if (status === "error") return <span className="text-[10px] px-2 py-0.5 rounded-full bg-red-500/15 text-red-600 border border-red-500/20">Validation Error</span>;
    return <span className="text-[10px] px-2 py-0.5 rounded-full bg-accent/10 text-accent border border-accent/20">Processing</span>;
  };

  const formatMetricValue = (m: {
    typical_value?: number;
    metric_type?: "currency" | "count" | "percent" | "ratio" | "volume" | "unknown";
    unit: string;
  }) => {
    if (m.typical_value == null) return null;
    const v = m.typical_value.toLocaleString();
    const kind = m.metric_type || "unknown";
    if (kind === "currency") return `${getCurrencySymbol()}${v}`;
    if (kind === "percent") return `${v}%`;
    if (kind === "ratio") return `${v}x`;
    if (kind === "volume") return `${v} units`;
    if (kind === "count") return v;
    return `${v}${m.unit ? ` ${m.unit}` : ""}`;
  };

  const getExtractionQuality = () => {
    const ms = context?.context_data?.model_schema;
    if (!ms) return null;

    const leverTotal = ms.scenarioLevers?.length || 0;
    const leverSeeded = (ms.scenarioLevers || []).filter((l) => {
      const base = Number((l as unknown as { scenarios?: { base?: number } }).scenarios?.base ?? 0);
      return Number.isFinite(base) && Math.abs(base) > 0;
    }).length;

    const metricTotal = ms.outputMetrics?.length || 0;
    const baseValues = (ms as unknown as { baseValues?: Record<string, number> }).baseValues || {};
    const metricSeeded = (ms.outputMetrics || []).filter((m) => {
      const v = Number(baseValues[m.id] ?? 0);
      return Number.isFinite(v) && Math.abs(v) > 0;
    }).length;

    return { leverSeeded, leverTotal, metricSeeded, metricTotal };
  };

  const spreadsheetNeedsValidation = documents.some(
    (doc) =>
      doc.document_kind === "spreadsheet_model" &&
      doc.validation_status !== "ready",
  );
  const contextNeedsValidation =
    modelValidationStatus === "needs_validation" ||
    context?.context_data?.validation_status === "needs_validation" ||
    (modelValidationStatus != null && modelValidationStatus !== "ready") ||
    (context?.context_data?.validation_status != null &&
      context.context_data.validation_status !== "ready");
  const needsValidation = spreadsheetNeedsValidation || contextNeedsValidation;

  return (
    <div className="p-5 max-h-[80vh] overflow-y-auto">
      <PanelHeader
        title="Document Manager"
        icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/></svg>}
        onClose={onClose}
        onMinimize={onMinimize || onClose}
        isMinimized={false}
      />

      {needsValidation && (
        <div className="mb-4 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 space-y-2">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-[var(--text-primary)]">
                Spreadsheet model needs analyst validation
              </p>
              <p className="text-xs text-[var(--text-secondary)] mt-0.5">
                Simulation is blocked until this model is marked ready. This will build context (if needed), validate against the Excel baseline, then you can re-run your scenario.
              </p>
            </div>
            <button
              type="button"
              onClick={handleValidateModel}
              disabled={validating}
              className="shrink-0 text-xs px-3 py-1.5 rounded-lg bg-accent text-white font-medium hover:bg-accent/90 transition-colors disabled:opacity-50"
            >
              {validating ? "Validating…" : "Mark Model Validated"}
            </button>
          </div>
          {buildError && (
            <p className="text-[11px] text-[var(--danger)]">{buildError}</p>
          )}
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 border-b border-[var(--border)] mb-4">
        {tabBtn("documents", `Documents (${documents.length})`)}
        {tabBtn("context", "Context")}
        {tabBtn("model", "Model")}
      </div>

      {/* ── Documents Tab ── */}
      {tab === "documents" && (
        <div className="space-y-4">
          {/* Upload area */}
          <div
            onDrop={handleDrop}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            className={`rounded-xl border-2 border-dashed p-6 text-center transition-all ${
              dragOver ? "border-accent bg-accent/5" : "border-[var(--border)] hover:border-accent/40"
            }`}
          >
            <input
              ref={fileRef}
              type="file"
              multiple
              accept=".pdf,.txt,.md,.csv,.docx,.xlsx"
              className="hidden"
              onChange={(e) => {
                if (e.target.files?.length) void handleUpload(e.target.files);
                e.target.value = "";
              }}
            />
            <p className="text-sm text-[var(--text-secondary)] mb-2">
              {uploading
                ? (uploadProgress || "Uploading...")
                : "Drag & drop files here, or click to browse"}
            </p>
            <button type="button" onClick={() => fileRef.current?.click()} disabled={uploading} className="text-accent text-sm font-medium hover:underline">
              Select Files
            </button>
            <p className="text-xs text-[var(--text-muted)] mt-1">PDF, TXT, MD, CSV, DOCX, XLSX — max 20MB each · multiple files supported</p>
          </div>

          {uploadError && (
            <div className="text-sm text-[var(--danger)] bg-[var(--danger-bg)] px-3 py-2 rounded-lg whitespace-pre-line">
              {uploadError}
            </div>
          )}

          {/* Document list */}
          {documents.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-[var(--text-primary)]">{documents.length} document{documents.length > 1 ? "s" : ""}</span>
                <div className="flex gap-2">
                  {readyDocs > 0 && !building && (
                    <button type="button" onClick={handleBuildContext} className="text-xs px-3 py-1.5 rounded-lg bg-accent text-white font-medium hover:bg-accent/90 transition-colors">
                      Build Context
                    </button>
                  )}
                  <button type="button" onClick={handleDeleteAll} className="text-xs px-3 py-1.5 rounded-lg border border-[var(--danger)]/30 text-[var(--danger)] hover:bg-[var(--danger-bg)] transition-colors">
                    Clear All
                  </button>
                </div>
              </div>

              {building && (
                <div className="bg-accent/5 border border-accent/20 rounded-lg p-3 text-sm text-accent flex items-center gap-2">
                  <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" strokeDasharray="31.4 31.4" strokeLinecap="round" /></svg>
                  Analyzing documents and building context... This may take a moment.
                </div>
              )}
              {buildError && <div className="text-sm text-[var(--danger)] bg-[var(--danger-bg)] px-3 py-2 rounded-lg">{buildError}</div>}

              {documents.map((doc) => (
                <div key={doc.document_id} className="flex items-center justify-between bg-[var(--card-bg)] border border-[var(--border)] rounded-lg px-3 py-2.5">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-[var(--text-primary)] truncate">{doc.original_filename}</p>
                    <p className="text-xs text-[var(--text-muted)]">
                      {kindLabel(doc.document_kind)} &middot; {(doc.file_size_bytes / 1024).toFixed(0)} KB &middot; {doc.chunk_count} chunks &middot;{" "}
                      <span className={doc.status === "ready" ? "text-[var(--success)]" : "text-[var(--warning)]"}>{doc.status}</span>
                    </p>
                    {ingestionSummary(doc) && (
                      <p className="text-[11px] text-[var(--text-secondary)] mt-0.5 truncate">{ingestionSummary(doc)}</p>
                    )}
                    {(doc.document_kind === "spreadsheet_model" || doc.document_kind === "tabular_data") && (
                      <div className="mt-1 flex flex-wrap gap-1.5 items-center">
                        {doc.document_kind === "spreadsheet_model" && validationPill(doc.validation_status)}
                        {doc.document_kind === "tabular_data" && (
                          <span className="text-[10px] px-2 py-0.5 rounded-full bg-[var(--panel-bg)] border border-[var(--border)] text-[var(--text-muted)]">
                            Data-only (no formulas)
                          </span>
                        )}
                        {doc.ingestion_report?.unit && (
                          <span className="text-[10px] px-2 py-0.5 rounded-full bg-accent/10 text-accent border border-accent/20">
                            {[doc.ingestion_report.currency, doc.ingestion_report.unit].filter(Boolean).join(" ")}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                  <button type="button" onClick={() => handleDelete(doc.document_id)} className="ml-2 text-[var(--text-muted)] hover:text-[var(--danger)] transition-colors" title="Delete">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                  </button>
                </div>
              ))}
            </div>
          )}

          {documents.length === 0 && (
            <div className="text-center py-8 text-[var(--text-muted)]">
              <p className="text-sm">No documents uploaded yet.</p>
              <p className="text-xs mt-1">Upload financial documents (P&L, income statements, reports) to build your company context.</p>
            </div>
          )}
        </div>
      )}

      {/* ── Context Tab ── */}
      {tab === "context" && (
        <div className="space-y-4">
          {!context ? (
            <div className="text-center py-8 text-[var(--text-muted)]">
              <p className="text-sm">No company context built yet.</p>
              <p className="text-xs mt-1">Upload documents first, then click &quot;Build Context&quot; to extract your company profile.</p>
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-lg font-semibold text-[var(--text-primary)]">{context.context_data.company_name}</h3>
                  <p className="text-sm text-[var(--text-secondary)]">{context.context_data.industry}</p>
                  {validationPill(modelValidationStatus || context.context_data.validation_status)}
                </div>
                <button type="button" onClick={handleResetContext} className="text-xs px-3 py-1.5 rounded-lg border border-[var(--danger)]/30 text-[var(--danger)] hover:bg-[var(--danger-bg)] transition-colors">
                  Reset
                </button>
              </div>
              {((modelValidationStatus || context.context_data.validation_status) === "needs_validation") && (
                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={handleValidateModel}
                    className="text-xs px-3 py-1.5 rounded-lg bg-accent text-white font-medium hover:bg-accent/90 transition-colors"
                  >
                    Mark Model Validated
                  </button>
                </div>
              )}

              {(ingestionReport || context.context_data.ingestion_report) && (
                <div className="bg-[var(--card-bg)] border border-[var(--border)] rounded-lg p-4 space-y-2">
                  <span className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">Structural Ingestion</span>
                  {(() => {
                    const r = ingestionReport || context.context_data.ingestion_report;
                    if (!r) return null;
                    return (
                      <>
                        <p className="text-xs text-[var(--text-secondary)]">{r.summary}</p>
                        {r.classification_evidence?.reason && (
                          <p className="text-[11px] text-[var(--text-muted)]">{r.classification_evidence.reason}</p>
                        )}
                        <div className="text-[11px] text-[var(--text-muted)] flex flex-wrap gap-x-3 gap-y-1">
                          {r.sheetCount != null && <span>Sheets: {r.sheetCount}</span>}
                          {r.formulaCount != null && <span>Formulas: {r.formulaCount}</span>}
                          {r.crossSheetLinkCount != null && <span>Cross-sheet links: {r.crossSheetLinkCount}</span>}
                          {(r.currency || r.unit) && (
                            <span>Denomination: {[r.currency, r.unit].filter(Boolean).join(" ")}</span>
                          )}
                          {r.executable != null && (
                            <span>{r.executable ? "Executable cell graph" : "Not executable"}</span>
                          )}
                        </div>
                        {r.warnings && r.warnings.length > 0 && (
                          <ul className="text-[11px] text-[var(--warning)] list-disc list-inside max-h-24 overflow-auto">
                            {r.warnings.slice(0, 8).map((w, i) => (
                              <li key={`${w.code}-${i}`}>{w.message}{w.cell ? ` (${w.sheet}!${w.cell})` : ""}</li>
                            ))}
                          </ul>
                        )}
                      </>
                    );
                  })()}
                </div>
              )}

              {(fidelityReport || context.context_data.runtime_validation?.fidelity) && (() => {
                const f = fidelityReport || context.context_data.runtime_validation?.fidelity;
                if (!f) return null;
                return (
                  <div className="bg-[var(--card-bg)] border border-[var(--border)] rounded-lg p-4 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">Fidelity Reconciliation</span>
                      <span className={`text-[10px] px-2 py-0.5 rounded-full border ${
                        f.ready
                          ? "bg-accent/10 text-accent border-accent/20"
                          : "bg-[var(--warning)]/10 text-[var(--warning)] border-[var(--warning)]/30"
                      }`}>
                        {f.ready ? "Ready" : "Blocked"} · score {(f.score * 100).toFixed(1)}%
                      </span>
                    </div>
                    <div className="text-[11px] text-[var(--text-muted)] flex flex-wrap gap-x-3 gap-y-1">
                      <span>Overall: {(f.score * 100).toFixed(1)}%</span>
                      <span>Key outputs: {(f.key_output_score * 100).toFixed(1)}%</span>
                      {f.compared_cells != null && <span>Compared: {f.compared_cells}</span>}
                      {f.unsupported_cells?.length > 0 && (
                        <span>Unsupported: {f.unsupported_cells.length}</span>
                      )}
                    </div>
                    {f.divergences?.length > 0 && (
                      <ul className="text-[11px] text-[var(--warning)] list-disc list-inside max-h-28 overflow-auto">
                        {f.divergences.slice(0, 8).map((d, i) => (
                          <li key={`${d.sheet}-${d.cell}-${i}`}>
                            {d.sheet}!{d.cell}: expected {d.expected}, got {Number.isFinite(d.actual) ? d.actual : "NaN"}
                            {d.is_key_output ? " (key output)" : ""}
                          </li>
                        ))}
                      </ul>
                    )}
                    {f.unsupported_cells?.length > 0 && (
                      <ul className="text-[11px] text-[var(--text-muted)] list-disc list-inside max-h-20 overflow-auto">
                        {f.unsupported_cells.slice(0, 5).map((u, i) => (
                          <li key={`${u.sheet}-${u.cell}-${i}`}>
                            Unsupported {u.sheet}!{u.cell}: {u.reason}
                          </li>
                        ))}
                      </ul>
                    )}
                    {f.missing_expected_key_outputs && f.missing_expected_key_outputs.length > 0 && (
                      <ul className="text-[11px] text-[var(--warning)] list-disc list-inside max-h-20 overflow-auto">
                        {f.missing_expected_key_outputs.slice(0, 5).map((m, i) => (
                          <li key={`${m.sheet}-${m.cell}-${i}`}>
                            Missing Excel cached result for key output {m.sheet}!{m.cell}
                            {m.id ? ` (${m.id})` : ""} — re-save/re-upload workbook
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                );
              })()}

              {(context.context_data.tie_out_status === "variances" ||
                (context.context_data.tie_out_variances && context.context_data.tie_out_variances.length > 0)) && (
                <div className="bg-[var(--card-bg)] border border-[var(--warning)]/30 rounded-lg p-4 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">P&amp;L Tie-out</span>
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-[var(--warning)]/10 text-[var(--warning)] border border-[var(--warning)]/30">
                      {context.context_data.usability === "needs_review" ? "Needs review" : "Variances"}
                    </span>
                  </div>
                  <ul className="text-[11px] text-[var(--warning)] list-disc list-inside max-h-28 overflow-auto">
                    {(context.context_data.tie_out_variances || []).slice(0, 8).map((v, i) => (
                      <li key={`${v.variable_id}-${i}`}>{v.message}</li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="bg-[var(--card-bg)] border border-[var(--border)] rounded-lg p-4 space-y-3">
                <div>
                  <span className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">Business Model</span>
                  <p className="text-sm text-[var(--text-primary)] mt-0.5">{context.context_data.business_model}</p>
                </div>
                {context.context_data.revenue_streams?.length > 0 && (
                  <div>
                    <span className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">Revenue Streams</span>
                    <div className="flex flex-wrap gap-1.5 mt-1">
                      {context.context_data.revenue_streams.map((s) => (
                        <span key={s} className="px-2 py-0.5 bg-accent/10 text-accent text-xs rounded-full">{s}</span>
                      ))}
                    </div>
                  </div>
                )}
                {context.context_data.competitive_landscape && (
                  <div>
                    <span className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">Competitive Landscape</span>
                    <p className="text-sm text-[var(--text-primary)] mt-0.5">{context.context_data.competitive_landscape}</p>
                  </div>
                )}
                {context.context_data.key_risks?.length > 0 && (
                  <div>
                    <span className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">Key Risks</span>
                    <ul className="text-sm text-[var(--text-primary)] mt-0.5 list-disc list-inside">
                      {context.context_data.key_risks.map((r, i) => <li key={i}>{r}</li>)}
                    </ul>
                  </div>
                )}
                {context.context_data.benchmarks && Object.keys(context.context_data.benchmarks).length > 0 && (
                  <div>
                    <span className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">Industry Benchmarks</span>
                    <div className="grid grid-cols-2 gap-2 mt-1">
                      {Object.entries(context.context_data.benchmarks).map(([k, v]) => (
                        <div key={k} className="text-xs"><span className="text-[var(--text-muted)]">{k}:</span> <span className="text-[var(--text-primary)]">{v}</span></div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <div>
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">Financial Metrics Extracted</span>
                  {(context.context_data.currency || context.context_data.currency_unit) && (
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-accent/10 text-accent font-medium border border-accent/20">
                      {context.context_data.currency}{context.context_data.currency_unit ? ` ${context.context_data.currency_unit}` : ""}
                    </span>
                  )}
                </div>
                <div className="mt-2 space-y-1.5">
                  {context.context_data.financial_metrics?.map((m) => (
                    <div key={m.variable_id} className="flex items-center justify-between bg-[var(--panel-bg)] rounded-lg px-3 py-2 text-sm">
                      <div>
                        <span className="font-medium text-[var(--text-primary)]">{m.name}</span>
                        <span className="ml-2 text-xs text-[var(--text-muted)]">
                          {m.category} {m.is_input ? "(input)" : "(calculated)"} {m.metric_type ? `• ${m.metric_type}` : ""}
                        </span>
                      </div>
                      {m.typical_value != null && (
                        <span className="text-xs font-mono text-accent">{formatMetricValue(m)}</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              {context.context_data.header_mapping_suggestions && context.context_data.header_mapping_suggestions.length > 0 && (
                <div className="bg-[var(--card-bg)] border border-[var(--border)] rounded-lg p-4 space-y-2">
                  <span className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">Header Mapping Suggestions</span>
                  {context.context_data.header_mapping_suggestions.map((s) => (
                    <div key={`${s.header_pattern}-${s.inferred_metric_type}`} className="bg-[var(--panel-bg)] rounded-lg px-3 py-2">
                      <p className="text-xs text-[var(--text-secondary)]">
                        <span className="font-semibold">Pattern:</span> {s.header_pattern}
                      </p>
                      <p className="text-xs text-[var(--text-secondary)]">
                        <span className="font-semibold">Type:</span> {s.inferred_metric_type} &middot; <span className="font-semibold">Unit:</span> {s.expected_unit}
                      </p>
                      <p className="text-xs text-[var(--text-muted)] mt-1">{s.mapping_guidance}</p>
                    </div>
                  ))}
                </div>
              )}

              <p className="text-xs text-[var(--text-muted)]">
                Built from {context.source_document_ids.length} document{context.source_document_ids.length !== 1 ? "s" : ""} &middot;{" "}
                {new Date(context.updated_at).toLocaleString()}
              </p>

              {context.context_data.model_schema && (
                <div className="bg-[var(--card-bg)] border border-[var(--border)] rounded-lg p-4 space-y-2">
                  <span className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">Model Schema (XLSX Structural)</span>
                  <div className="text-xs text-[var(--text-secondary)]">
                    <span className="font-semibold">Levers:</span> {context.context_data.model_schema.scenarioLevers?.length || 0}
                    {" · "}
                    <span className="font-semibold">Outputs:</span> {context.context_data.model_schema.outputMetrics?.length || 0}
                    {" · "}
                    <span className="font-semibold">Time:</span> {context.context_data.model_schema.timeDimension?.granularity || "unknown"}
                  </div>
                  {(() => {
                    const q = getExtractionQuality();
                    if (!q) return null;
                    return (
                      <div className="text-[11px] text-[var(--text-muted)] bg-[var(--panel-bg)] rounded px-2 py-1 border border-[var(--border)]">
                        Extraction quality: <span className="font-semibold text-[var(--text-secondary)]">{q.leverSeeded}/{q.leverTotal}</span> levers seeded with non-zero base values,{" "}
                        <span className="font-semibold text-[var(--text-secondary)]">{q.metricSeeded}/{q.metricTotal}</span> metrics seeded with non-zero base values.
                      </div>
                    );
                  })()}
                  <div className="flex flex-wrap gap-1.5">
                    {(context.context_data.model_schema.scenarioLevers || []).slice(0, 6).map((lever) => (
                      <span key={lever.id} className="px-2 py-0.5 bg-accent/10 text-accent text-xs rounded-full">
                        {lever.label || lever.id}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* ── Model Tab ── */}
      {tab === "model" && (
        <div className="space-y-4">
          {!model ? (
            <div className="text-center py-8 text-[var(--text-muted)]">
              <p className="text-sm">No model generated yet.</p>
              <p className="text-xs mt-1">Build context from documents to auto-generate a financial model.</p>
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-base font-semibold text-[var(--text-primary)]">{model.name}</h3>
                  <p className="text-xs text-[var(--text-muted)]">
                    {model.model_definition.variables.length} variables &middot; {model.model_definition.time_horizon.granularity} &middot;{" "}
                    {model.model_definition.time_horizon.start} to {model.model_definition.time_horizon.end}
                  </p>
                </div>
              </div>

              <div className="space-y-1.5">
                {model.model_definition.variables.map((v) => (
                  <div key={v.id} className="bg-[var(--card-bg)] border border-[var(--border)] rounded-lg px-3 py-2.5">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-[var(--text-primary)]">{v.name}</span>
                        <span className="text-xs text-[var(--text-muted)] font-mono">{v.id}</span>
                        {v.tags?.map((t) => (
                          <span key={t} className="px-1.5 py-0.5 text-[10px] rounded bg-accent/10 text-accent">{t}</span>
                        ))}
                      </div>
                      <button
                        type="button"
                        onClick={() => setEditingVar(editingVar === v.id ? null : v.id)}
                        className="text-xs text-accent hover:underline"
                      >
                        {editingVar === v.id ? "Close" : "Edit"}
                      </button>
                    </div>
                    <p className="text-xs text-[var(--text-muted)] mt-0.5 font-mono">
                      Formula: {v.formula}
                      {v.dependencies.length > 0 && ` → depends on: ${v.dependencies.join(", ")}`}
                    </p>
                    {editingVar === v.id && (
                      <div className="mt-2 space-y-2">
                        <div>
                          <label className="text-xs text-[var(--text-muted)]">Formula / Base Value</label>
                          <input
                            type="text"
                            defaultValue={v.formula}
                            onBlur={(e) => handleUpdateVariable(v.id, "formula", e.target.value)}
                            className="w-full mt-0.5 px-2 py-1 text-sm rounded border border-[var(--border)] bg-[var(--panel-bg)] text-[var(--text-primary)] font-mono"
                          />
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
