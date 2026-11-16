"use client";
import { fmt } from "@/lib/client";
import type { FilteredRecords, OrbBacktest, SwingBacktest, TrackRecord } from "@/lib/backtest";
import { FILTERS, passes, type MarketContext, type SignalContext } from "@/lib/market";
import type { TradePlan } from "@/lib/plan";
import { clockLabel, type OrbHit, type SwingNumbers, type SwingSetup } from "@/lib/setups";

// Shared by the Setups page and the ticker page.

export interface SetupsResult {
  symbol: string;
  swing: null | { lastDate: string; close: number; atr14?: number; tags: SwingSetup[]; numbers: SwingNumbers; market?: MarketContext; context: SignalContext; backtest: SwingBacktest };
  intraday: null | {
    session: { date: string; bars: number; full: boolean; inProgress: boolean };
    status: "triggered" | "waiting" | "forming" | "no-breakout";
    orHigh?: number;
    orLow?: number;
    lastPrice?: number;
    hit: OrbHit | null;
    market?: MarketContext;
    context?: SignalContext;
    stop?: number;
    backtest: OrbBacktest;
  };
  warnings: string[];
}

export const signedR = (r: number) => `${r >= 0 ? "+" : ""}${r.toFixed(2)}R`;

export function Edge({ r }: { r?: number }) {
  if (r === undefined) return <span className="muted">—</span>;
  return <span className={r > 0.05 ? "up" : r < -0.05 ? "down" : ""}>{signedR(r)}</span>;
}

export function RecordCell({ rec }: { rec: TrackRecord }) {
  if (!rec.trades) return <span className="muted">{rec.verdict}</span>;
  return (
    <>
      <span className={rec.avgR > 0.05 ? "up" : rec.avgR < -0.05 ? "down" : ""}>{signedR(rec.avgR)}</span>
      <span className="muted"> avg · {rec.trades} trades · win {fmt.pct(rec.winRate, 0)}</span>
      <div className="muted">
        target {rec.target} · stop {rec.stop} · timed out {rec.time}
        {rec.sample === "thin" && <span className="down"> · too few to trust</span>}
      </div>
    </>
  );
}

export function PlanCell({ plan }: { plan?: TradePlan }) {
  if (!plan || plan.status === "NONE") return <span className="muted">{plan?.reason ?? "—"}</span>;
  if (plan.status === "BLOCKED") return <span className="down" title={plan.checks.filter((c) => !c.pass).map((c) => c.detail).join("\n")}>{plan.reason.replace("Blocked. ", "Blocked: ")}</span>;
  return (
    <>
      <span>Buy {plan.shares} · stop <span className="down mono">{fmt.num(plan.stop)}</span> · target <span className="up mono">{fmt.num(plan.target)}</span></span>
      <div className="muted">risk {fmt.money(plan.maxLoss)} · {fmt.money(plan.cost)} · by {plan.sizedBy}</div>
    </>
  );
}

export function OrbStatus({ d }: { d: NonNullable<SetupsResult["intraday"]> }) {
  if (d.status === "triggered" && d.hit) {
    return (
      <>
        <span className="up">Triggered</span> {clockLabel(d.hit.atMinute)} @ <span className="mono">{fmt.num(d.hit.price)}</span>
        <div className="muted">{d.hit.pctOver.toFixed(2)}% over the range{d.session.inProgress ? "" : " · session over"}</div>
      </>
    );
  }
  if (d.status === "waiting" && d.orHigh && d.lastPrice) {
    return <>Waiting · <span className="mono">{((d.orHigh / d.lastPrice - 1) * 100).toFixed(2)}%</span> below the range high</>;
  }
  if (d.status === "forming") return <span className="muted">Opening range forming</span>;
  return <span className="muted">No breakout</span>;
}

export function MarketBanner({ m }: { m: MarketContext }) {
  const cls = m.trend === "up" ? "up" : m.trend === "down" ? "down" : "";
  return (
    <div className={m.trend === "down" ? "warn" : "panel"} style={{ padding: "10px 14px" }}>
      <span className="small">
        Market ({m.symbol}, {m.date}): <b className={cls}>{m.trend === "up" ? "uptrend" : m.trend === "down" ? "downtrend" : "mixed"}</b> · {m.detail}
        {m.return3m !== undefined && <> · 3 months {fmt.signedPct(m.return3m)}</>}
        {m.trend === "down" && " · long setups fail more often in a falling market"}
      </span>
    </div>
  );
}

export function Confirm({ ctx, volumeX }: { ctx: SignalContext; volumeX: number }) {
  const mark = (ok: boolean | undefined) => (ok === undefined ? <span className="muted">?</span> : ok ? <span className="up">✓</span> : <span className="down">✗</span>);
  return (
    <div className="confirm">
      <span title="SPY above its 50-day average">{mark(ctx.marketUp)} Market</span>
      <span title="3-month return minus SPY's">{mark(ctx.rs === undefined ? undefined : ctx.rs > 0)} RS {ctx.rs !== undefined ? fmt.signedPct(ctx.rs) : ""}</span>
      <span title={`Volume vs average (needs ≥${volumeX}×)`}>{mark(ctx.volX === undefined ? undefined : ctx.volX >= volumeX)} Vol {ctx.volX !== undefined ? `${ctx.volX.toFixed(1)}×` : ""}</span>
      {passes(ctx, "all", volumeX) && <span className="up">all confirmed</span>}
    </div>
  );
}

export function FilteredLine({ f }: { f?: FilteredRecords }) {
  if (!f) return null;
  return (
    <div className="muted filtered-line">
      When confirmed:{" "}
      {FILTERS.map((x, i) => {
        const r = f[x.key];
        return (
          <span key={x.key} title={`${x.label}: ${x.rule}. ${r.verdict}`}>
            {i ? " · " : ""}
            {x.key === "all" ? "all" : x.key === "rs" ? "RS" : x.key === "volume" ? "vol" : "mkt"}{" "}
            {r.trades ? <span className={r.avgR > 0.05 ? "up" : r.avgR < -0.05 ? "down" : ""}>{signedR(r.avgR)}</span> : "—"}
            <span> ({r.trades})</span>
          </span>
        );
      })}
    </div>
  );
}
