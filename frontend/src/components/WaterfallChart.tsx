"use client";

import { useMemo } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Cell,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";

import { METRIC_ORDER, METRIC_LABELS, fmtCurrency, getCurrencySymbol } from "@/lib/metrics";
import { chartColors, formatCompactCurrency } from "@/lib/chartTheme";
import { ChartDataTable } from "./ChartDataTable";

interface WaterfallChartProps {
  pl: Record<string, number>;
  basePl?: Record<string, number>;
  title?: string;
}

const COLORS = {
  positive: chartColors.positive,
  negative: chartColors.negative,
  total: "var(--text-primary)",
  base: "var(--text-faint)",
};

interface WaterfallItem {
  name: string;
  value: number;
  start: number;
  end: number;
  fill: string;
  isTotal: boolean;
}

export function WaterfallChart({ pl, basePl, title = "P&L Waterfall" }: WaterfallChartProps) {
  const data = useMemo(() => {
    const items: WaterfallItem[] = [];
    let running = 0;

    for (const metric of METRIC_ORDER) {
      if (!(metric in pl)) continue;
      const val = pl[metric];

      if (metric === "revenue") {
        // Revenue is the starting bar
        items.push({
          name: METRIC_LABELS[metric] || metric,
          value: val,
          start: 0,
          end: val,
          fill: COLORS.positive,
          isTotal: true,
        });
        running = val;
      } else if (metric === "net_income" || metric === "ebitda") {
        // Totals
        items.push({
          name: METRIC_LABELS[metric] || metric,
          value: val,
          start: 0,
          end: val,
          fill: COLORS.total,
          isTotal: true,
        });
      } else {
        // Intermediate items (COGS, OpEx subtracted from running)
        const delta = metric === "gross_margin" ? val - running : val;
        const isSubtraction = metric === "cogs" || metric === "opex";
        const amount = isSubtraction ? -val : delta;
        const start = running;
        running += amount;
        items.push({
          name: METRIC_LABELS[metric] || metric,
          value: amount,
          start: Math.min(start, running),
          end: Math.max(start, running),
          fill: amount >= 0 ? COLORS.positive : COLORS.negative,
          isTotal: false,
        });
      }
    }

    return items;
  }, [pl]);

  // Delta waterfall (if base provided)
  const deltaData = useMemo(() => {
    if (!basePl) return null;
    const items: WaterfallItem[] = [];
    for (const metric of METRIC_ORDER) {
      if (!(metric in pl) || !(metric in basePl)) continue;
      const delta = pl[metric] - basePl[metric];
      items.push({
        name: METRIC_LABELS[metric] || metric,
        value: delta,
        start: 0,
        end: delta,
        fill: delta >= 0 ? COLORS.positive : COLORS.negative,
        isTotal: false,
      });
    }
    return items;
  }, [pl, basePl]);

  const CustomTooltip = ({ active, payload }: { active?: boolean; payload?: Array<{ payload: WaterfallItem }> }) => {
    if (!active || !payload?.length) return null;
    const item = payload[0].payload;
    return (
      <div className="bg-[var(--card-bg)] border border-[var(--card-border)] rounded-lg shadow-panel px-3 py-2">
        <p className="text-xs font-semibold text-[var(--text-primary)]">{item.name}</p>
        <p className="text-xs text-[var(--text-secondary)]">
          {item.value >= 0 ? "+" : ""}{fmtCurrency(item.value)}
        </p>
      </div>
    );
  };

  return (
    <div>
      <p className="text-[11px] font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-2">{title}</p>
      <div className="h-52">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} barCategoryGap="20%">
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border-light)" />
            <XAxis
              dataKey="name"
              tick={{ fontSize: 10, fill: "var(--text-faint)" }}
              axisLine={{ stroke: "var(--border)" }}
              tickLine={false}
            />
            <YAxis
              tick={{ fontSize: 10, fill: "var(--text-faint)" }}
              tickFormatter={(v: number) => formatCompactCurrency(v, getCurrencySymbol())}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip content={<CustomTooltip />} />
            <ReferenceLine y={0} stroke="var(--border)" />
            {/* Invisible base bar for floating effect */}
            <Bar dataKey="start" stackId="waterfall" fill="transparent" />
            {/* Visible value bar */}
            <Bar dataKey={(d: WaterfallItem) => d.end - d.start} stackId="waterfall" radius={[3, 3, 0, 0]}>
              {data.map((item, idx) => (
                <Cell key={idx} fill={item.fill} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
        <ChartDataTable
          caption={title}
          columns={["Metric", "Value", "Start", "End"]}
          rows={data.map((d) => [d.name, d.value, d.start, d.end])}
        />
      </div>

      {/* Delta waterfall */}
      {deltaData && (
        <div className="mt-4">
          <p className="text-[11px] font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-2">Impact vs. Base Case</p>
          <div className="h-40">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={deltaData} barCategoryGap="20%">
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border-light)" />
                <XAxis
                  dataKey="name"
                  tick={{ fontSize: 10, fill: "var(--text-faint)" }}
                  axisLine={{ stroke: "var(--border)" }}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fontSize: 10, fill: "var(--text-faint)" }}
              tickFormatter={(v: number) => formatCompactCurrency(v, getCurrencySymbol())}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip content={<CustomTooltip />} />
            <ReferenceLine y={0} stroke="var(--border)" strokeWidth={1.5} />
                <Bar dataKey="value" radius={[3, 3, 0, 0]}>
                  {deltaData.map((item, idx) => (
                    <Cell key={idx} fill={item.fill} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </div>
  );
}
