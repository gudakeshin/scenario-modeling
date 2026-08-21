"use client";

import { useState } from "react";
import { toast } from "sonner";
import {
  getExcelExportUrl,
  getCsvExportUrl,
  getPptxExportUrl,
  getPdfExportUrl,
  downloadWithAuth,
} from "@/lib/api";

const LABELS = { excel: "Excel", csv: "CSV", pptx: "PPTX", pdf: "PDF" } as const;

interface ExportControlsProps {
  scenarioId: string;
}

export function ExportControls({ scenarioId }: ExportControlsProps) {
  const [downloading, setDownloading] = useState<string | null>(null);

  const handleExport = async (format: "excel" | "csv" | "pptx" | "pdf") => {
    setDownloading(format);
    try {
      const urlMap = {
        excel: getExcelExportUrl,
        csv: getCsvExportUrl,
        pptx: getPptxExportUrl,
        pdf: getPdfExportUrl,
      };
      const extMap = { excel: "xlsx", csv: "csv", pptx: "pptx", pdf: "pdf" };
      const url = urlMap[format](scenarioId);
      await downloadWithAuth(
        url,
        `scenario_${scenarioId.slice(0, 8)}.${extMap[format]}`,
        format === "pdf" ? "POST" : "GET",
      );
      toast.success(`${LABELS[format]} export downloaded`);
    } catch (e) {
      toast.error("Export failed", { description: (e as Error).message });
    }
    setDownloading(null);
  };

  const Spinner = () => (
    <svg className="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" strokeDasharray="31.4 31.4" strokeLinecap="round" />
    </svg>
  );

  const btnClass =
    "inline-flex items-center gap-1 rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--panel-bg)] hover:shadow-card transition-all disabled:opacity-40";

  return (
    <div className="flex items-center gap-2" role="group" aria-label="Export scenario">
      <span className="text-xs text-[var(--text-faint)] mr-1" aria-hidden="true">Export:</span>
      <button type="button" onClick={() => handleExport("excel")} disabled={!!downloading} aria-busy={downloading === "excel"} className={btnClass}>
        <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
        </svg>
        {downloading === "excel" && <Spinner />}
        Excel
      </button>
      <button type="button" onClick={() => handleExport("csv")} disabled={!!downloading} aria-busy={downloading === "csv"} className={btnClass}>
        <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
        </svg>
        {downloading === "csv" && <Spinner />}
        CSV
      </button>
      <button type="button" onClick={() => handleExport("pptx")} disabled={!!downloading} aria-busy={downloading === "pptx"} className={btnClass}>
        <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
        </svg>
        {downloading === "pptx" && <Spinner />}
        PPTX
      </button>
      <button type="button" onClick={() => handleExport("pdf")} disabled={!!downloading} aria-busy={downloading === "pdf"} className={btnClass}>
        <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
        </svg>
        {downloading === "pdf" && <Spinner />}
        PDF
      </button>
    </div>
  );
}
