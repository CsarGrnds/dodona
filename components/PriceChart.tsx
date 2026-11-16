"use client";
import { CandlestickSeries, ColorType, createChart, createSeriesMarkers, LineSeries, type IChartApi, type UTCTimestamp } from "lightweight-charts";
import { useEffect, useRef } from "react";
import { sma } from "@/lib/indicators";
import type { CallRecord } from "@/lib/store";
import type { Bar } from "@/lib/types";

const toTs = (d: string) => (Date.parse(d.length === 10 ? `${d}T00:00:00Z` : d) / 1000) as UTCTimestamp;

export interface ChartLine {
  price: number;
  color: string;
  title: string;
  dashed?: boolean;
}

export default function PriceChart({ bars, calls, levels, lines }: { bars: Bar[]; calls: CallRecord[]; levels?: Record<string, number | undefined>; lines?: ChartLine[] }) {
  const el = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!el.current || bars.length === 0) return;
    const chart: IChartApi = createChart(el.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: "#8a93a6", fontFamily: "ui-monospace, Menlo, monospace" },
      grid: { vertLines: { color: "#1a2030" }, horzLines: { color: "#1a2030" } },
      rightPriceScale: { borderColor: "#232b3b" },
      timeScale: { borderColor: "#232b3b" },
      crosshair: { mode: 0 },
    });

    const candles = chart.addSeries(CandlestickSeries, {
      upColor: "#2fbf71", downColor: "#e5534b", borderVisible: false, wickUpColor: "#2fbf71", wickDownColor: "#e5534b",
    });
    candles.setData(bars.map((b) => ({ time: toTs(b.time), open: b.open, high: b.high, low: b.low, close: b.close })));

    const closes = bars.map((b) => b.close);
    for (const [period, color] of [[50, "#c9a24a"], [200, "#6c8cff"]] as const) {
      const line = chart.addSeries(LineSeries, { color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
      const s = sma(closes, period);
      line.setData(bars.map((b, i) => ({ time: toTs(b.time), value: s[i] })).filter((p) => Number.isFinite(p.value)));
    }

    // Horizontal decision levels.
    const levelColors: Record<string, string> = { buyBelow: "#2fbf71", trimAbove: "#e5534b", stopLoss: "#e5534b", takeProfit: "#2fbf71" };
    const labels: Record<string, string> = { buyBelow: "Buy below", trimAbove: "Trim above", stopLoss: "Stop", takeProfit: "Target" };
    for (const [k, v] of Object.entries(levels ?? {})) {
      if (v) candles.createPriceLine({ price: v, color: levelColors[k] ?? "#8a93a6", lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: labels[k] ?? k });
    }

    // Support / resistance and plan lines.
    for (const l of lines ?? []) candles.createPriceLine({ price: l.price, color: l.color, lineWidth: 1, lineStyle: l.dashed ? 2 : 0, axisLabelVisible: true, title: l.title });

    // Past agent calls as markers (one per day, only when the call changed).
    const first = toTs(bars[0].time);
    const markers: { time: UTCTimestamp; position: "belowBar" | "aboveBar" | "inBar"; color: string; shape: "arrowUp" | "arrowDown" | "circle"; text: string }[] = [];
    let lastAction = "";
    for (const c of calls) {
      if (c.action === lastAction) continue;
      lastAction = c.action;
      const day = toTs(c.generatedAt.slice(0, 10));
      if (day < first) continue;
      markers.push(
        c.action === "BUY"
          ? { time: day, position: "belowBar", color: "#2fbf71", shape: "arrowUp", text: "BUY" }
          : c.action === "SELL"
            ? { time: day, position: "aboveBar", color: "#e5534b", shape: "arrowDown", text: "SELL" }
            : { time: day, position: "inBar", color: "#8a93a6", shape: "circle", text: "HOLD" },
      );
    }
    const dedup = new Map(markers.map((m) => [m.time, m]));
    createSeriesMarkers(candles, [...dedup.values()].sort((a, b) => a.time - b.time));

    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [bars, calls, levels, lines]);

  return <div ref={el} className="chart" />;
}
