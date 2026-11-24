// Pure and shared: the strategist's roster. Each strategy finds at most one long day trade in a stock's
// session from completed 5-minute bars (no peeking at a bar before it closes), and every trade is played
// out the same way: stop first when a bar touches both, target 2R, sold at the 3:55 bar's close.
// `npm run research` replays them over Yahoo's ~60 days of 5-minute bars on each morning's shortlist,
// rebuilt from the closes known the evening before, and prints what each one would have made after
// IBKR's fees at the user's budget. Evidence for the user, never a switch: the team trades only what
// the user turned on.
import { ibkrFeeEstimate } from "./ibkrOrder";
import { nyClock, type IntradayBar } from "./setups";

export interface Trade {
  strategy: string;
  entryAt: number; // bar time (ms) the entry filled in
  entry: number;
  stop: number;
  R: number; // result in units of the entry-to-stop risk
  outcome: "target" | "stop" | "close";
}

export interface StrategyDef {
  id: string;
  label: string;
  rule: string; // one plain sentence
  live?: boolean; // what the team trades today
  find: (day: IntradayBar[], prevClose?: number) => Omit<Trade, "R" | "outcome" | "strategy"> & { at: number } | null;
}

const FLAT = 15 * 60 + 55;
const minute = (b: IntradayBar) => nyClock(b.t).minute;

/** Hold a long from bar `i` (filled at `entry`), stop first, 2R target, flat at 3:55. */
export function hold(day: IntradayBar[], i: number, entry: number, stop: number): { R: number; outcome: Trade["outcome"] } {
  const risk = entry - stop;
  const target = entry + 2 * risk;
  for (let j = i; j < day.length; j++) {
    const b = day[j];
    if (b.low <= stop) return { R: (Math.min(stop, j === i ? Math.min(b.open, stop) : stop) - entry) / risk, outcome: "stop" };
    if (b.high >= target) return { R: 2, outcome: "target" };
    if (minute(b) >= FLAT) return { R: (b.close - entry) / risk, outcome: "close" };
  }
  return { R: (day[day.length - 1].close - entry) / risk, outcome: "close" };
}

function vwapSeries(day: IntradayBar[]): number[] {
  let pv = 0, v = 0;
  return day.map((b) => {
    pv += ((b.high + b.low + b.close) / 3) * b.volume;
    v += b.volume;
    return v ? pv / v : b.close;
  });
}

/** An opening range of `n` bars; a buy-stop at its high from the next bar on, stop at its low. */
function orb(n: number, minPct: number, maxPct: number) {
  return (day: IntradayBar[]) => {
    if (day.length < n + 2) return null;
    const or = day.slice(0, n);
    const H = Math.max(...or.map((b) => b.high)), L = Math.min(...or.map((b) => b.low));
    const pct = ((H - L) / H) * 100;
    if (!(pct >= minPct && pct <= maxPct)) return null;
    for (let j = n; j < day.length && minute(day[j]) < 15 * 60; j++) {
      if (day[j].high >= H) return { at: j, entryAt: day[j].t, entry: Math.max(H, day[j].open), stop: L };
    }
    return null;
  };
}

export const STRATEGY_ROSTER: StrategyDef[] = [
  {
    id: "orb15",
    label: "Opening-range breakout (15 min)",
    rule: "A buy-stop at the first 15 minutes' high, stop at their low; range 1.5-6% of the price.",
    live: true,
    find: orb(3, 1.5, 6),
  },
  {
    id: "orb30",
    label: "Opening-range breakout (30 min)",
    rule: "The same with the first 30 minutes: a slower range, fewer false starts.",
    find: orb(6, 1.5, 8),
  },
  {
    id: "orb-retest",
    label: "Breakout retest",
    rule: "After a 5-minute close above the 15-minute range high, a buy limit back at that high; stop at the range low.",
    find: (day) => {
      if (day.length < 6) return null;
      const or = day.slice(0, 3);
      const H = Math.max(...or.map((b) => b.high)), L = Math.min(...or.map((b) => b.low));
      const pct = ((H - L) / H) * 100;
      if (!(pct >= 1.5 && pct <= 6)) return null;
      const bo = day.findIndex((b, j) => j >= 3 && b.close > H);
      if (bo < 0) return null;
      for (let j = bo + 1; j < day.length && minute(day[j]) < 15 * 60; j++) {
        if (day[j].low <= L) return null; // it fell through the whole range first: no retest, a failure
        if (day[j].low <= H) return { at: j, entryAt: day[j].t, entry: Math.min(H, day[j].open), stop: L };
      }
      return null;
    },
  },
  {
    id: "gap-go",
    label: "Gap and go",
    rule: "Opens 2%+ above yesterday's close and the first 5 minutes close green: a buy-stop above that bar's high, stop at its low.",
    find: (day, prevClose) => {
      if (!prevClose || day.length < 3) return null;
      const first = day[0];
      if (!(first.open >= prevClose * 1.02 && first.close > first.open)) return null;
      const H = first.high, L = first.low;
      if (!(((H - L) / H) * 100 >= 0.8)) return null;
      for (let j = 1; j < day.length && minute(day[j]) < 11 * 60; j++) {
        if (day[j].low < L) return null; // the gap failed before it triggered
        if (day[j].high >= H) return { at: j, entryAt: day[j].t, entry: Math.max(H, day[j].open), stop: L };
      }
      return null;
    },
  },
  {
    id: "vwap-pullback",
    label: "VWAP pullback",
    rule: "A stock that broke its 15-minute range pulls back to VWAP after 10:00 and a bar closes back above it: buy the next bar's open, stop under that bar's low.",
    find: (day) => {
      if (day.length < 10) return null;
      const H = Math.max(...day.slice(0, 3).map((b) => b.high));
      const vw = vwapSeries(day);
      let broke = false;
      for (let j = 3; j < day.length - 1 && minute(day[j + 1]) < 15 * 60; j++) {
        if (day[j].close > H) broke = true;
        if (!broke || minute(day[j]) < 10 * 60) continue;
        const b = day[j];
        if (b.low <= vw[j] * 1.001 && b.close > vw[j] && b.close > b.open) {
          const stop = Math.min(b.low, vw[j] * 0.995);
          const entry = day[j + 1].open;
          if (entry > stop && ((entry - stop) / entry) * 100 >= 0.4) return { at: j + 1, entryAt: day[j + 1].t, entry, stop };
          return null;
        }
      }
      return null;
    },
  },
];

/** Run one strategy on one session (regular-hours bars, oldest first). */
export function runStrategy(s: StrategyDef, day: IntradayBar[], prevClose?: number): Trade | null {
  const f = s.find(day, prevClose);
  if (!f) return null;
  const h = hold(day, f.at, f.entry, f.stop);
  return { strategy: s.id, entryAt: f.entryAt, entry: f.entry, stop: f.stop, ...h };
}

/** A trade's R after IBKR's fees, sized like the desk: risk_pct of the budget, at most max_position_pct of it. */
export function netR(t: Pick<Trade, "R" | "entry" | "stop">, budget: number, riskPct = 2, maxPositionPct = 75): number | undefined {
  const risk = t.entry - t.stop;
  const shares = Math.min(Math.floor((budget * riskPct) / 100 / risk), Math.floor((budget * maxPositionPct) / 100 / t.entry));
  if (!(shares >= 1)) return undefined;
  return (t.R * risk * shares - ibkrFeeEstimate(shares, t.entry)) / (risk * shares);
}

export interface StrategyStats {
  id: string;
  label: string;
  rule: string;
  live: boolean;
  trades: number;
  grossR: number; // average R before fees
  ci95: number; // ± around grossR
  winPct: number;
  targets: number;
  stops: number;
  closes: number;
  netAtBudget?: number; // average R after fees at the user's budget
  sizedAtBudget: number; // trades one share or more fits at the user's budget
  netAt5k?: number;
  olderHalf: number; // gross R, first half of the days
  newerHalf: number;
  verdict: "edge" | "maybe" | "no edge" | "too few";
  why: string;
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const r2 = (x: number) => Math.round(x * 100) / 100;

/** What the evidence says. "edge" needs the whole 95% range above zero AND a profit after fees at the budget. */
export function strategyStats(s: StrategyDef, trades: Trade[], budget: number, riskPct = 2, maxPositionPct = 75): StrategyStats {
  const g = trades.map((t) => t.R);
  const m = avg(g);
  const sd = Math.sqrt(avg(g.map((x) => (x - m) ** 2)));
  const ci95 = trades.length ? (2 * sd) / Math.sqrt(trades.length) : 0;
  const atB = trades.map((t) => netR(t, budget, riskPct, maxPositionPct)).filter((x): x is number => x !== undefined);
  const at5k = trades.map((t) => netR(t, 5000, riskPct, maxPositionPct)).filter((x): x is number => x !== undefined);
  const sorted = [...trades].sort((a, b) => a.entryAt - b.entryAt);
  const half = Math.floor(sorted.length / 2);
  const netB = atB.length ? avg(atB) : undefined;
  let verdict: StrategyStats["verdict"], why: string;
  if (trades.length < 30) (verdict = "too few"), (why = `only ${trades.length} trades: not enough to tell`);
  else if (m - ci95 > 0 && (netB ?? -1) > 0) (verdict = "edge"), (why = `positive even at the low end of its 95% range, and after fees at $${budget}`);
  else if (m > 0) (verdict = "maybe"), (why = netB !== undefined && netB <= 0 ? `positive before fees, but fees take it under zero at $${budget}` : "positive on average, but the 95% range still includes zero");
  else (verdict = "no edge"), (why = "loses on average before fees");
  return {
    id: s.id, label: s.label, rule: s.rule, live: !!s.live, trades: trades.length, grossR: r2(m), ci95: r2(ci95),
    winPct: Math.round((trades.filter((t) => t.R > 0).length / Math.max(1, trades.length)) * 100),
    targets: trades.filter((t) => t.outcome === "target").length, stops: trades.filter((t) => t.outcome === "stop").length, closes: trades.filter((t) => t.outcome === "close").length,
    ...(netB !== undefined ? { netAtBudget: r2(netB) } : {}), sizedAtBudget: atB.length, ...(at5k.length ? { netAt5k: r2(avg(at5k)) } : {}),
    olderHalf: r2(avg(sorted.slice(0, half).map((t) => t.R))), newerHalf: r2(avg(sorted.slice(half).map((t) => t.R))), verdict, why,
  };
}
