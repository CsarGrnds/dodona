"use client";
// The stop ticket's chart: the holding's last months of daily candles with the stop at IBKR now, the
// new stop the ticket would send, and your average cost, so a raise is seen before it's sent. Display only.
import { CandlestickSeries, ColorType, createChart, LineStyle, type IChartApi, type IPriceLine, type ISeriesApi, type LineWidth, type UTCTimestamp } from "lightweight-charts";
import { useEffect, useRef, useState } from "react";
import type { Bar } from "@/lib/types";

const ts = (d: string) => (Date.parse(`${d}T00:00:00Z`) / 1000) as UTCTimestamp;

export function StopChart({ symbol, current, next, cost }: { symbol: string; current?: number; next?: number; cost?: number }) {
  const el = useRef<HTMLDivElement>(null);
  const [bars, setBars] = useState<Bar[]>();
  const [err, setErr] = useState<string>();
  const chart = useRef<{ api: IChartApi; candles: ISeriesApi<"Candlestick">; lines: IPriceLine[] }>(undefined);

  useEffect(() => {
    let live = true;
    fetch(`/api/bars?symbol=${encodeURIComponent(symbol)}&days=120`, { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => live && (j.bars?.length ? setBars(j.bars) : setErr(j.error ?? "No bars")))
      .catch((e) => live && setErr(String(e)));
    return () => {
      live = false;
    };
  }, [symbol]);

  // the candles: once per symbol
  useEffect(() => {
    if (!el.current || !bars?.length) return;
    const css = getComputedStyle(document.documentElement);
    const v = (k: string, d: string) => css.getPropertyValue(k).trim() || d;
    const api = createChart(el.current, {
      height: 200,
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: v("--muted", "#8a93a6"), fontFamily: v("--mono", "monospace"), attributionLogo: false },
      grid: { vertLines: { visible: false }, horzLines: { color: "rgba(138,147,166,0.08)" } },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, fixLeftEdge: true, fixRightEdge: true },
      handleScroll: false,
      handleScale: false,
    });
    const up = v("--buy", "#2fbf71"), down = v("--sell", "#e5534b");
    const candles = api.addSeries(CandlestickSeries, { upColor: up, downColor: down, wickUpColor: up, wickDownColor: down, borderVisible: false, priceLineVisible: false });
    const seen = new Set<number>();
    candles.setData(bars.map((b) => ({ time: ts(b.time), open: b.open, high: b.high, low: b.low, close: b.close })).filter((p) => (seen.has(p.time) ? false : (seen.add(p.time), true))));
    api.timeScale().fitContent();
    chart.current = { api, candles, lines: [] };
    return () => {
      chart.current = undefined;
      api.remove();
    };
  }, [bars]);

  // the lines: whenever the ticket's numbers change
  useEffect(() => {
    const c = chart.current;
    if (!c) return;
    for (const l of c.lines) c.candles.removePriceLine(l);
    const css = getComputedStyle(document.documentElement);
    const v = (k: string, d: string) => css.getPropertyValue(k).trim() || d;
    const want: Array<[number | undefined, string, string, LineStyle, LineWidth]> = [
      [cost, "cost", v("--muted", "#8a93a6"), LineStyle.Dotted, 1],
      [current, "stop now", v("--sell", "#e5534b"), LineStyle.Dashed, 1],
      [next, "new stop", v("--accent", "#c9a24a"), LineStyle.Solid, 2],
    ];
    c.lines = want.filter(([p]) => typeof p === "number" && p > 0).map(([price, title, color, lineStyle, lineWidth]) => c.candles.createPriceLine({ price: price!, title, color, lineStyle, lineWidth, axisLabelVisible: true }));
    // keep every line in view, not just the candles' range
    const lo = Math.min(...[cost, current, next].filter((p): p is number => !!p && p > 0));
    c.candles.applyOptions({
      autoscaleInfoProvider: (base: () => { priceRange: { minValue: number; maxValue: number } } | null) => {
        const r = base();
        return r && Number.isFinite(lo) ? { ...r, priceRange: { minValue: Math.min(r.priceRange.minValue, lo * 0.995), maxValue: r.priceRange.maxValue } } : r;
      },
    });
  }, [bars, current, next, cost]);

  if (err) return null;
  return (
    <div className="st-chart">
      <div ref={el} aria-label={`${symbol} daily chart with the stop lines`} />
      <div className="small muted">
        Daily · <span className="st-key st-new">new stop</span> <span className="st-key st-now">stop now</span> <span className="st-key st-cost">cost</span>
      </div>
    </div>
  );
}
