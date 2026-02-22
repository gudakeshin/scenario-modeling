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
  type DocumentRecord,
  type CompanyContext,
  type UserModel,
} from "@/lib/api";
import { getCurrencySymbol } from "@/lib/metrics";

type Tab = "documents" | "context" | "model";

interface Props {
  onClose: () => void;
  onMinimize?: () => void;
  onContextBuilt?: () => void;
}

export function DocumentManager({ onClose, onMinimize, onContextBuilt }: Props) {
  const [tab, setTab] = useState<Tab>("documents");
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [context, setContext] = useState<CompanyContext | null>(null);
  const [model, setModel] = useState<UserModel | null>(null);
  const [building, setBuilding] = useState(false);
  const [buildError, setBuildError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [editingVar, setEditingVar] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const loadDocuments = useCallback(async () => {
    try { setDocuments(await listDocuments()); } catch { /* ignore */ }
  }, []);

  const loadContext = useCallback(async () => {
    try {
      const { context: ctx } = await getCompanyContext();
      setContext(ctx);
    } catch { /* ignore */ }
  }, []);

  const loadModel = useCallback(async () => {
    try {
      const { model: m } = await getActiveModel();
      setModel(m);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { loadDocuments(); loadContext(); loadModel(); }, [loadDocuments, loadContext, loadModel]);

  const handleUpload = async (file: File) => {
    setUploading(true);
    setUploadError(null);
    try {
      await uploadDocument(file);
      await loadDocuments();
    } catch (e) {
      setUploadError((e as Error).message);
    }
    setUploading(false);
  };

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) handleUpload(file);
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

  return (
    <div className="p-5 max-h-[80vh] overflow-y-auto">
      <PanelHeader
        title="Document Manager"
        icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/></svg>}
        onClose={onClose}
        onMinimize={onMinimize || onClose}
        isMinimized={false}
      />

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
            <input ref={fileRef} type="file" accept=".pdf,.txt,.md,.csv,.docx" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleUpload(f); e.target.value = ""; }} />
            <p className="text-sm text-[var(--text-secondary)] mb-2">
              {uploading ? "Uploading..." : "Drag & drop a file here, or click to browse"}
            </p>
            <button type="button" onClick={() => fileRef.current?.click()} disabled={uploading} className="text-accent text-sm font-medium hover:underline">
              Select File
            </button>
            <p className="text-xs text-[var(--text-muted)] mt-1">PDF, TXT, MD, CSV, DOCX — max 20MB</p>
          </div>

          {uploadError && <div className="text-sm text-[var(--danger)] bg-[var(--danger-bg)] px-3 py-2 rounded-lg">{uploadError}</div>}

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
                      {(doc.file_size_bytes / 1024).toFixed(0)} KB &middot; {doc.chunk_count} chunks &middot;{" "}
                      <span className={doc.status === "ready" ? "text-[var(--success)]" : "text-[var(--warning)]"}>{doc.status}</span>
                    </p>
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
                </div>
                <button type="button" onClick={handleResetContext} className="text-xs px-3 py-1.5 rounded-lg border border-[var(--danger)]/30 text-[var(--danger)] hover:bg-[var(--danger-bg)] transition-colors">
                  Reset
                </button>
              </div>

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
                        <span className="ml-2 text-xs text-[var(--text-muted)]">{m.category} {m.is_input ? "(input)" : "(calculated)"}</span>
                      </div>
                      {m.typical_value != null && (
                        <span className="text-xs font-mono text-accent">{getCurrencySymbol()}{m.typical_value.toLocaleString()}</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              <p className="text-xs text-[var(--text-muted)]">
                Built from {context.source_document_ids.length} document{context.source_document_ids.length !== 1 ? "s" : ""} &middot;{" "}
                {new Date(context.updated_at).toLocaleString()}
              </p>
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
