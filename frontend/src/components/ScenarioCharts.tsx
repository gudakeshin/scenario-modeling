"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { toast } from "sonner";
import { WaterfallChart } from "./WaterfallChart";
import { PanelHeader } from "./PanelHeader";
import { TrendLineChart } from "./TrendLineChart";
import { getPovSlice, type PeriodResult, type DimensionalResultBlock } from "@/lib/api";
import { applyPovSlice } from "@/lib/dimensionalPov";
import { DimensionPovControls } from "./DimensionPovControls";

interface ScenarioChartsProps {
  pl: Record<string, number>;
  basePl?: Record<string, number>;
  periods?: PeriodResult[];
  granularity?: "monthly" | "quarterly";
  dimensional?: DimensionalResultBlock;
  scenarioId?: string | null;
  onClose: () => void;
  onMinimize?: () => void;
}

type Tab = "waterfall" | "trends";

function chartExportBackground(): string {
  if (typeof window === "undefined") return "#FFFFFF";
  const styles = getComputedStyle(document.documentElement);
  return (
    styles.getPropertyValue("--card-bg").trim() ||
    styles.getPropertyValue("--background").trim() ||
    "#FFFFFF"
  );
}

export function ScenarioCharts({ pl, basePl, periods, granularity, dimensional, scenarioId, onClose, onMinimize }: ScenarioChartsProps) {
  const [activeTab, setActiveTab] = useState<Tab>("waterfall");
  const [displayData, setDisplayData] = useState({ pl, periods });
  const [displayDimensional, setDisplayDimensional] = useState(dimensional);
  const [povLoading, setPovLoading] = useState(false);
  const chartRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setDisplayData({ pl, periods });
    setDisplayDimensional(dimensional);
  }, [pl, periods, dimensional]);

  const handlePovChange = useCallback(async (pov: Record<string, string>, metrics?: string[]) => {
    if (!scenarioId) return;
    setPovLoading(true);
    try {
      const slice = await getPovSlice(scenarioId, pov, metrics);
      setDisplayData((current) => applyPovSlice(current, slice));
      if (slice.dimensional) setDisplayDimensional(slice.dimensional);
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setPovLoading(false);
    }
  }, [scenarioId]);

  const exportPNG = useCallback(async () => {
    if (!chartRef.current) return;
    try {
      const svg = chartRef.current.querySelector("svg");
      if (!svg) {
        toast.error("No chart available to export");
        return;
      }

      const svgData = new XMLSerializer().serializeToString(svg);
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        toast.error("Could not create export canvas");
        return;
      }

      const img = new Image();
      const svgBlob = new Blob([svgData], { type: "image/svg+xml;charset=utf-8" });
      const url = URL.createObjectURL(svgBlob);

      img.onload = () => {
        try {
          canvas.width = img.width * 2;
          canvas.height = img.height * 2;
          ctx.scale(2, 2);
          ctx.fillStyle = chartExportBackground();
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0);
          URL.revokeObjectURL(url);

          const pngUrl = canvas.toDataURL("image/png");
          const link = document.createElement("a");
          link.download = `scenario-${activeTab}-chart.png`;
          link.href = pngUrl;
          link.click();
        } catch {
          toast.error("Failed to export chart as PNG");
        }
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        toast.error("Failed to export chart as PNG");
      };
      img.src = url;
    } catch {
      toast.error("Failed to export chart as PNG");
    }
  }, [activeTab]);

  const hasPeriods = displayData.periods && displayData.periods.length > 1;

  return (
    <div className="border border-[var(--panel-border)] rounded-2xl bg-[var(--card-bg)] p-4 mx-4 mb-3 overflow-auto max-h-[65vh] shadow-panel">
      {/* Header */}
      <PanelHeader
        title="Scenario Visualizations"
        icon={<div className="w-5 h-5 rounded-md bg-accent/10 flex items-center justify-center"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2.5"><path d="M3 3v18h18" /><path d="M7 16l4-8 4 4 6-10" /></svg></div>}
        onClose={onClose}
        onMinimize={onMinimize || onClose}
        isMinimized={false}
        actions={
          <button
            type="button"
            onClick={exportPNG}
            className="text-[10px] px-2.5 py-1 rounded-lg border border-[var(--border)] text-[var(--text-muted)] hover:bg-[var(--panel-bg)] hover:shadow-card transition-all"
            title="Export chart as PNG"
          >
            Export PNG
          </button>
        }
      />

      {/* Tabs */}
      <div className="flex rounded-lg border border-[var(--border)] overflow-hidden mb-4 w-fit">
        <button
          type="button"
          onClick={() => setActiveTab("waterfall")}
          className={`text-xs px-3.5 py-1.5 font-medium transition-colors ${
            activeTab === "waterfall" ? "bg-accent text-white" : "text-[var(--text-muted)] hover:bg-[var(--panel-bg)]"
          }`}
        >
          P&L Waterfall
        </button>
        {hasPeriods && (
          <button
            type="button"
            onClick={() => setActiveTab("trends")}
            className={`text-xs px-3.5 py-1.5 font-medium transition-colors ${
              activeTab === "trends" ? "bg-accent text-white" : "text-[var(--text-muted)] hover:bg-[var(--panel-bg)]"
            }`}
          >
            Trend Lines
          </button>
        )}
      </div>

      {/* Chart content */}
      <div ref={chartRef}>
        {activeTab === "waterfall" && (
          <WaterfallChart pl={displayData.pl} basePl={basePl} />
        )}
        {activeTab === "trends" && hasPeriods && displayData.periods && (
          <TrendLineChart periods={displayData.periods} granularity={granularity || "quarterly"} />
        )}
      </div>

      {displayDimensional && (
        <DimensionPovControls
          dimensional={displayDimensional}
          onPovChange={scenarioId ? handlePovChange : undefined}
          loading={povLoading}
        />
      )}
    </div>
  );
}
