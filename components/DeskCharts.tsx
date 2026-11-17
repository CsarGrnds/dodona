"use client";
// Charts for the paper desk: equity curve, daily P&L bars, a P&L calendar and the R distribution.
import { AreaSeries, ColorType, createChart, HistogramSeries, LineStyle, type UTCTimestamp } from "lightweight-charts";
import { useEffect, useMemo, useRef } from "react";

export interface DayRow {
  date: string;
  equity: number;
  pnl: number;
  pnlPct: number;
  realized: number;
  closed: number;
  wins: number;
  losses: number;
}

const ts = (d: string) => (Date.parse(`${d}T00:00:00Z`) / 1000) as UTCTimestamp;
const css = () => {
  const s = getComputedStyle(document.documentElement);
  const v = (k: string, d: string) => s.getPropertyValue(k).trim() || d;
  return { buy: v("--buy", "#2fbf71"), sell: v("--sell", "#e5534b"), muted: v("--muted", "#8a93a6"), accent: v("--accent", "#c9a24a") };
};
export const signedUsd = (v: number) => `${v < 0 ? "−" : "+"}$${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function baseChart(el: HTMLElement, height: number) {
  const c = css();
  return createChart(el, {
    height,
    autoSize: true,
    layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: c.muted, attributionLogo: false },
    grid: { vertLines: { visible: false }, horzLines: { color: "rgba(138,147,166,0.08)" } },
    rightPriceScale: { borderVisible: false },
    timeScale: { borderVisible: false, fixLeftEdge: true, fixRightEdge: true },
    handleScroll: false,
    handleScale: false,
    crosshair: { horzLine: { visible: false } },
  });
}

export function EquityChart({ days, startCash, startDate }: { days: DayRow[]; startCash: number; startDate: string }) {
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!el.current) return;
    const c = css();
    const last = days.at(-1)?.equity ?? startCash;
    const color = last >= startCash ? c.buy : c.sell;
    const chart = baseChart(el.current, 220);
    const s = chart.addSeries(AreaSeries, { lineColor: color, topColor: `${color}55`, bottomColor: `${color}05`, lineWidth: 2, priceFormat: { type: "price", precision: 2, minMove: 0.01 } });
    const pts = new Map<number, number>();
    pts.set(ts(startDate), startCash);
    for (const d of days) pts.set(ts(d.date), d.equity);
    const data = [...pts.entries()].sort((a, b) => a[0] - b[0]).map(([time, value]) => ({ time: time as UTCTimestamp, value }));
    if (data.length === 1) data.push({ time: (data[0].time + 86_400) as UTCTimestamp, value: data[0].value });
    s.setData(data);
    s.createPriceLine({ price: startCash, color: c.muted, lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: true, title: "start" });
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [days, startCash, startDate]);
  return <div ref={el} className="dk-plot" />;
}

export function DailyPnlChart({ days }: { days: DayRow[] }) {
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!el.current || !days.length) return;
    const c = css();
    const chart = baseChart(el.current, 220);
    const s = chart.addSeries(HistogramSeries, { priceFormat: { type: "price", precision: 2, minMove: 0.01 } });
    s.setData(days.map((d) => ({ time: ts(d.date), value: d.pnl, color: d.pnl >= 0 ? c.buy : c.sell })));
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [days]);
  if (!days.length) return <div className="dk-empty">No trading days yet: the first bar appears after the desk's first session.</div>;
  return <div ref={el} className="dk-plot" />;
}

/** GitHub-style calendar of the last 15 weeks, colored by the day's P&L. */
export function PnlCalendar({ days }: { days: DayRow[] }) {
  const cells = useMemo(() => {
    const by = new Map(days.map((d) => [d.date, d]));
    const max = Math.max(1, ...days.map((d) => Math.abs(d.pnl)));
    const today = new Date();
    const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
    end.setUTCDate(end.getUTCDate() + (5 - end.getUTCDay() + 7) % 7); // to Friday
    const out: Array<{ date: string; day?: DayRow; level: number; weekend: boolean }> = [];
    for (let i = 15 * 7 - 1; i >= 0; i--) {
      const d = new Date(end.getTime() - i * 86_400_000);
      const wd = d.getUTCDay();
      if (wd === 0 || wd === 6) continue;
      const key = d.toISOString().slice(0, 10);
      const day = by.get(key);
      out.push({ date: key, day, level: day ? Math.ceil((Math.abs(day.pnl) / max) * 4) * Math.sign(day.pnl) : 0, weekend: false });
    }
    return out;
  }, [days]);
  return (
    <div className="dk-cal-wrap">
      <div className="dk-cal">
        {cells.map((c) => (
          <i
            key={c.date}
            className={c.day ? (c.level > 0 ? `g${c.level}` : c.level < 0 ? `r${-c.level}` : "z") : ""}
            title={c.day ? `${c.date}: ${signedUsd(c.day.pnl)} (${c.day.closed} closed, ${c.day.wins} won)` : c.date}
          />
        ))}
      </div>
      <div className="dk-cal-key muted small">
        Loss <i className="r4" /><i className="r2" /><i className="z" /><i className="g2" /><i className="g4" /> Gain
      </div>
    </div>
  );
}

/** How the closed trades ended, in R (the loss at the first stop = −1R). */
export function RDistribution({ rs }: { rs: number[] }) {
  const buckets = [
    { label: "≤ −1R", test: (r: number) => r <= -1 },
    { label: "−1 to 0", test: (r: number) => r > -1 && r <= 0 },
    { label: "0 to 1", test: (r: number) => r > 0 && r < 1 },
    { label: "1 to 2", test: (r: number) => r >= 1 && r < 2 },
    { label: "≥ 2R", test: (r: number) => r >= 2 },
  ].map((b) => ({ ...b, n: rs.filter(b.test).length }));
  const max = Math.max(1, ...buckets.map((b) => b.n));
  if (!rs.length) return <div className="dk-empty">No closed trades yet.</div>;
  return (
    <div className="dk-rdist">
      {buckets.map((b, i) => (
        <div key={b.label} className="dk-rcol">
          <span className="mono small">{b.n || ""}</span>
          <div className={i < 2 ? "neg" : "pos"} style={{ height: `${(b.n / max) * 100}%` }} />
          <span className="muted small">{b.label}</span>
        </div>
      ))}
    </div>
  );
}
