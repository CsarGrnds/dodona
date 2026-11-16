"use client";
// Account value over time, like IBKR's portfolio chart: daily NAV (or return %) with period tabs.
import { AreaSeries, ColorType, createChart, type UTCTimestamp } from "lightweight-charts";
import { useEffect, useRef, useState } from "react";
import { Spinner } from "@/components/ui";
import { fmt } from "@/lib/client";
import { PERIODS, type Performance, type PeriodKey } from "@/lib/performance";

const KEY = "dodona.perf.period.v1";
const ts = (d: string) => (Date.parse(`${d}T00:00:00Z`) / 1000) as UTCTimestamp;
const signed = (v: number) => `${v < 0 ? "−" : "+"}$${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function AccountChart() {
  const [period, setPeriod] = useState<PeriodKey>("1M");
  const [mode, setMode] = useState<"value" | "return">("value");
  const [perf, setPerf] = useState<Performance>();
  const [fail, setFail] = useState<{ state?: string; error: string }>();
  const [busy, setBusy] = useState(false);
  const el = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      const p = localStorage.getItem(KEY);
      if (p && PERIODS.some((x) => x.key === p)) setPeriod(p as PeriodKey);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    let live = true;
    setBusy(true);
    setFail(undefined);
    fetch(`/api/performance?period=${period}`, { cache: "no-store" })
      .then(async (r) => {
        const j = await r.json();
        if (!live) return;
        if (!r.ok) setFail({ state: j.state, error: j.error ?? `HTTP ${r.status}` });
        else setPerf(j.performance);
      })
      .catch((e) => live && setFail({ error: String(e) }))
      .finally(() => live && setBusy(false));
    return () => {
      live = false;
    };
  }, [period]);

  const up = perf ? (mode === "value" ? perf.navChange : perf.twr) >= 0 : true;

  useEffect(() => {
    if (!el.current || !perf || perf.points.length < 2) return;
    const css = getComputedStyle(document.documentElement);
    const color = (up ? css.getPropertyValue("--buy") : css.getPropertyValue("--sell")).trim() || (up ? "#2fbf71" : "#e5534b");
    const chart = createChart(el.current, {
      height: 180,
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: css.getPropertyValue("--muted").trim() || "#8a93a6", attributionLogo: false },
      grid: { vertLines: { visible: false }, horzLines: { color: "rgba(138,147,166,0.08)" } },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, fixLeftEdge: true, fixRightEdge: true },
      handleScroll: false,
      handleScale: false,
      crosshair: { horzLine: { visible: false } },
    });
    const series = chart.addSeries(AreaSeries, {
      lineColor: color,
      topColor: `${color}55`,
      bottomColor: `${color}05`,
      lineWidth: 2,
      priceFormat: mode === "value" ? { type: "price", precision: 0, minMove: 1 } : { type: "custom", formatter: (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%` },
    });
    const seen = new Set<number>();
    const data = [{ time: ts(perf.start.date), value: mode === "value" ? perf.start.nav : 0 }, ...perf.points.map((p) => ({ time: ts(p.date), value: mode === "value" ? p.nav : p.twr * 100 }))]
      .filter((p) => (seen.has(p.time) ? false : (seen.add(p.time), true)))
      .sort((a, b) => a.time - b.time);
    series.setData(data);
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [perf, mode, up]);

  const pick = (p: PeriodKey) => {
    setPeriod(p);
    try {
      localStorage.setItem(KEY, p);
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="acct-chart">
      <div className="row" style={{ marginBottom: 6 }}>
        {perf && (
          <div>
            <div className="acct-value mono">{fmt.money(perf.end, perf.currency)}</div>
            <div className={`small mono ${up ? "up" : "down"}`}>
              {signed(perf.gain)} ({fmt.signedPct(perf.twr)}) <span className="muted">{PERIODS.find((x) => x.key === period)?.label} return</span>
            </div>
          </div>
        )}
        <span className="spacer" />
        <div className="seg">
          {PERIODS.map((p) => (
            <button key={p.key} className={period === p.key ? "on" : ""} onClick={() => pick(p.key)}>{p.label}</button>
          ))}
        </div>
        <div className="seg">
          <button className={mode === "value" ? "on" : ""} onClick={() => setMode("value")}>$</button>
          <button className={mode === "return" ? "on" : ""} onClick={() => setMode("return")}>%</button>
        </div>
      </div>
      {fail ? (
        <div className="muted small">
          {fail.state === "login" ? "Log in to the IBKR gateway to see your account chart." : fail.state === "down" ? "The IBKR gateway isn't running: say “refresh IBKR” to start it, then reload." : `Account chart unavailable: ${fail.error}`}
        </div>
      ) : !perf ? (
        <div className="muted small"><Spinner /> Loading account history from IBKR…</div>
      ) : (
        <>
          <div ref={el} className="acct-plot" style={{ opacity: busy ? 0.5 : 1 }} />
          <div className="muted small">
            Account value {fmt.money(perf.start.nav, perf.currency)} on {perf.start.date} → {fmt.money(perf.end, perf.currency)}: {signed(perf.navChange)}, of which ≈{signed(perf.gain)} is investment return and ≈{signed(perf.netDeposits)} net deposits/withdrawals. Return is IBKR&apos;s time-weighted return (deposits don&apos;t count as gains); IBKR updates it once a day.
          </div>
        </>
      )}
    </div>
  );
}
