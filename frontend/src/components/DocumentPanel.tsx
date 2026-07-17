"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import {
  uploadDocument,
  listDocuments,
  deleteDocument,
  queryDocument,
  queryAllDocuments,
  type DocumentRecord,
  type RAGResponse,
  type RAGSource,
} from "@/lib/api";
import { PanelHeader } from "./PanelHeader";
import { MarkdownContent } from "./MarkdownContent";

interface DocumentPanelProps {
  onClose: () => void;
  onMinimize?: () => void;
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  sources?: RAGSource[];
  timestamp: Date;
}

export function DocumentPanel({ onClose, onMinimize }: DocumentPanelProps) {
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [selectedDocId, setSelectedDocId] = useState<string | null>(null);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [showSources, setShowSources] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // Scroll to bottom on new messages
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatMessages]);

  const loadDocuments = useCallback(async () => {
    try {
      const docs = await listDocuments();
      setDocuments(docs);
    } catch {
      // Silently fail if API not ready
    }
  }, []);

  // Load documents on mount and poll while queued/processing.
  useEffect(() => {
    void loadDocuments();
  }, [loadDocuments]);
  useEffect(() => {
    if (!documents.some((doc) => doc.status === "queued" || doc.status === "processing")) return;
    const timer = window.setInterval(() => void loadDocuments(), 2_000);
    return () => window.clearInterval(timer);
  }, [documents, loadDocuments]);

  const handleUpload = async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (list.length === 0) return;

    setUploading(true);
    setUploadError(null);
    setUploadProgress(null);

    const failures: string[] = [];
    let lastDoc: DocumentRecord | null = null;

    for (let i = 0; i < list.length; i++) {
      const file = list[i];
      setUploadProgress(`Uploading ${i + 1} of ${list.length}: ${file.name}`);
      try {
        const doc = await uploadDocument(file);
        lastDoc = doc;
        setDocuments((prev) => [doc, ...prev.filter((d) => d.document_id !== doc.document_id)]);
      } catch (e) {
        failures.push(`${file.name}: ${(e as Error).message}`);
      }
    }

    if (lastDoc) {
      setSelectedDocId(lastDoc.document_id);
      const okCount = list.length - failures.length;
      setChatMessages((prev) => [
        ...prev,
        {
          id: `sys-${Date.now()}`,
          role: "assistant",
          content:
            okCount === 1
              ? lastDoc.status === "queued"
                ? `Document **"${lastDoc.name}"** was queued for ingestion. Progress will update automatically.`
                : `Document **"${lastDoc.name}"** uploaded and processed successfully! It has been split into ${lastDoc.chunk_count} searchable chunks (keyword search by default; hybrid vector search when embeddings are configured). You can now ask questions about it.`
              : `Uploaded **${okCount}** documents successfully. You can now ask questions about them.`,
          timestamp: new Date(),
        },
      ]);
    }

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

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.length) void handleUpload(e.target.files);
    if (e.target) e.target.value = "";
  };

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files.length > 0) {
      void handleUpload(e.dataTransfer.files);
    }
  }, []);

  const handleDelete = async (docId: string) => {
    try {
      await deleteDocument(docId);
      setDocuments((prev) => prev.filter((d) => d.document_id !== docId));
      if (selectedDocId === docId) setSelectedDocId(null);
    } catch {
      // ignore
    }
  };

  const handleAsk = async () => {
    if (!question.trim() || asking) return;

    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      content: question.trim(),
      timestamp: new Date(),
    };
    setChatMessages((prev) => [...prev, userMsg]);
    setQuestion("");
    setAsking(true);

    try {
      let result: RAGResponse;
      if (selectedDocId) {
        result = await queryDocument(selectedDocId, userMsg.content, conversationId ?? undefined);
      } else {
        result = await queryAllDocuments(userMsg.content, conversationId ?? undefined);
      }

      if (result.conversation_id) setConversationId(result.conversation_id);

      const assistantMsg: ChatMessage = {
        id: `asst-${Date.now()}`,
        role: "assistant",
        content: result.answer,
        sources: result.sources,
        timestamp: new Date(),
      };
      setChatMessages((prev) => [...prev, assistantMsg]);
    } catch (e) {
      setChatMessages((prev) => [
        ...prev,
        {
          id: `err-${Date.now()}`,
          role: "assistant",
          content: `Sorry, I encountered an error: ${(e as Error).message}`,
          timestamp: new Date(),
        },
      ]);
    }
    setAsking(false);
  };

  const selectedDoc = documents.find((d) => d.document_id === selectedDocId);

  return (
    <div className="p-5">
      <PanelHeader
        title="Talk to Documents"
        icon={
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="16" y1="13" x2="8" y2="13" />
            <line x1="16" y1="17" x2="8" y2="17" />
            <polyline points="10 9 9 9 8 9" />
          </svg>
        }
        onClose={onClose}
        onMinimize={onMinimize || onClose}
        isMinimized={false}
      />

      {/* ── Document Upload Area ── */}
      <div
        className={`mb-4 rounded-xl border-2 border-dashed p-4 text-center transition-all cursor-pointer ${
          dragOver
            ? "border-accent bg-accent/10"
            : "border-[var(--border)] hover:border-accent/40 hover:bg-[var(--panel-bg)]"
        }`}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept=".pdf,.txt,.md,.csv,.docx,.xlsx,.xlsm"
          onChange={handleFileSelect}
          className="hidden"
        />
        {uploading ? (
          <div className="flex items-center justify-center gap-2 text-sm text-accent">
            <svg className="animate-spin h-5 w-5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            {uploadProgress || "Processing documents..."}
          </div>
        ) : (
          <div>
            <svg className="mx-auto h-8 w-8 text-[var(--text-faint)] mb-2" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
            </svg>
            <p className="text-sm text-[var(--text-secondary)]">
              Drop files here or <span className="text-accent font-medium">browse</span>
            </p>
            <p className="text-xs text-[var(--text-faint)] mt-1">PDF, TXT, MD, CSV, DOCX, XLSX, XLSM — max 50MB each · multiple files supported</p>
          </div>
        )}
      </div>
      {uploadError && (
        <div className="mb-3 p-2 rounded-lg bg-[var(--danger-bg)] text-[var(--danger)] text-xs whitespace-pre-line">
          {uploadError}
        </div>
      )}

      {/* ── Document List ── */}
      {documents.length > 0 && (
        <div className="mb-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold text-[var(--text-secondary)] uppercase tracking-wider">
              Documents ({documents.length})
            </span>
            <button
              type="button"
              onClick={() => { setSelectedDocId(null); }}
              className={`text-xs px-2 py-0.5 rounded-md transition-colors ${
                !selectedDocId ? "bg-accent/15 text-accent font-medium" : "text-[var(--text-faint)] hover:text-accent"
              }`}
            >
              Search All
            </button>
          </div>
          <div className="space-y-1.5 max-h-36 overflow-y-auto pr-1">
            {documents.map((doc) => (
              <div
                key={doc.document_id}
                className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-xs cursor-pointer transition-all group ${
                  selectedDocId === doc.document_id
                    ? "border-accent/30 bg-accent/8 text-accent shadow-sm"
                    : "border-[var(--border)] hover:border-[var(--panel-border)] text-[var(--text-primary)]"
                }`}
                onClick={() => setSelectedDocId(doc.document_id === selectedDocId ? null : doc.document_id)}
              >
                {/* File type icon */}
                <span className="text-base">
                  {doc.file_type.includes("pdf") ? "📄" : doc.file_type.includes("csv") ? "📊" : "📝"}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate">{doc.name}</div>
                  <div className="text-[var(--text-faint)]">
                    {doc.chunk_count} chunks &middot; {(doc.file_size_bytes / 1024).toFixed(0)}KB
                    <span className={`ml-1.5 px-1.5 py-0.5 rounded-full text-[9px] font-medium ${
                      doc.status === "ready" ? "bg-[rgb(134,188,37)]/15 text-[rgb(134,188,37)]"
                        : doc.status === "processing" ? "bg-amber-400/15 text-amber-500"
                        : "bg-[var(--danger-bg)] text-[var(--danger)]"
                    }`}>
                      {doc.status}
                    </span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); handleDelete(doc.document_id); }}
                  className="opacity-0 group-hover:opacity-100 w-6 h-6 rounded flex items-center justify-center text-[var(--text-faint)] hover:text-[var(--danger)] hover:bg-[var(--danger-bg)] transition-all"
                  title="Delete document"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Chat with Document ── */}
      <div className="border border-[var(--border)] rounded-xl bg-background overflow-hidden">
        {/* Chat header */}
        <div className="px-3 py-2 bg-[var(--panel-bg)] border-b border-[var(--border)] flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-accent animate-pulse" />
          <span className="text-xs font-medium text-[var(--text-secondary)]">
            {selectedDoc ? `Chatting with: ${selectedDoc.name}` : "Chat with all documents"}
          </span>
        </div>

        {/* Messages */}
        <div className="h-64 overflow-y-auto p-3 space-y-3">
          {chatMessages.length === 0 && (
            <div className="flex items-center justify-center h-full text-sm text-[var(--text-faint)]">
              {documents.length > 0
                ? "Ask a question about your documents..."
                : "Upload a document to get started"}
            </div>
          )}
          {chatMessages.map((msg) => (
            <div
              key={msg.id}
              className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`max-w-[85%] rounded-xl px-3 py-2 text-sm ${
                  msg.role === "user"
                    ? "bg-accent text-white"
                    : "bg-[var(--panel-bg)] border border-[var(--border)] text-[var(--text-primary)]"
                }`}
              >
                {msg.role === "user" ? (
                  <div className="whitespace-pre-wrap">{msg.content}</div>
                ) : (
                  <MarkdownContent content={msg.content} />
                )}
                {msg.sources && msg.sources.length > 0 && (
                  <div className="mt-2 pt-2 border-t border-[var(--border)]/30">
                    <button
                      type="button"
                      onClick={() => setShowSources(showSources === msg.id ? null : msg.id)}
                      className="text-xs text-accent/80 hover:text-accent flex items-center gap-1"
                    >
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                        <polyline points="14 2 14 8 20 8" />
                      </svg>
                      {msg.sources.length} source{msg.sources.length > 1 ? "s" : ""}
                      <svg
                        width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                        className={`transition-transform ${showSources === msg.id ? "rotate-180" : ""}`}
                      >
                        <polyline points="6 9 12 15 18 9" />
                      </svg>
                    </button>
                    {showSources === msg.id && (
                      <div className="mt-2 space-y-1.5">
                        {msg.sources.map((src, i) => (
                          <div key={i} className="p-2 rounded-lg bg-background text-xs">
                            <div className="flex items-center justify-between mb-1">
                              <span className="font-medium text-[var(--text-secondary)]">
                                {src.document_name} (chunk {src.chunk_index})
                              </span>
                              <span className="text-[var(--text-faint)]">
                                {(src.score * 100).toFixed(0)}% match
                              </span>
                            </div>
                            <p className="text-[var(--text-faint)] line-clamp-3">{src.text}</p>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          ))}
          {asking && (
            <div className="flex justify-start">
              <div className="bg-[var(--panel-bg)] border border-[var(--border)] rounded-xl px-3 py-2 text-sm text-[var(--text-faint)]">
                <span className="animate-pulse">Searching documents and generating answer...</span>
              </div>
            </div>
          )}
          <div ref={chatEndRef} />
        </div>

        {/* Input */}
        <div className="p-2 border-t border-[var(--border)]">
          <form
            onSubmit={(e) => { e.preventDefault(); handleAsk(); }}
            className="flex gap-2"
          >
            <input
              type="text"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder={
                documents.length > 0
                  ? selectedDoc
                    ? `Ask about "${selectedDoc.name}"...`
                    : "Ask across all documents..."
                  : "Upload a document first..."
              }
              disabled={documents.length === 0 || asking}
              className="flex-1 px-3 py-2 rounded-lg border border-[var(--border)] bg-background text-sm text-[var(--text-primary)] placeholder-[var(--text-faint)] focus:outline-none focus:border-accent/50 focus:ring-1 focus:ring-accent/30 disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={!question.trim() || asking || documents.length === 0}
              className="px-4 py-2 rounded-lg bg-accent text-white text-sm font-medium hover:bg-accent/90 disabled:opacity-40 transition-colors shrink-0"
            >
              {asking ? (
                <svg className="animate-spin h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
              ) : (
                "Ask"
              )}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
