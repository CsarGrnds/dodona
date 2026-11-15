// Track records: how a setup actually played out every past time it fired on this stock.
//
// Swing: each past day a daily setup fired, enter at that close with Dodona's trade plan
//   (stop = entry − stopAtr × ATR14 rounded down, target = entry + targetR × risk) and walk the
//   following days: stop checked before target in every bar (a bar touching both is a loss,
//   like the Time Machine), else exit at the close after maxHoldDays. No overlapping trades of
//   the same setup. Compared with a baseline: buying ANY day and holding maxHoldDays.
//
// Intraday: the Time Machine's history replay (history_replay in timemachine.py) on every full
//   session: entry at the first close above the opening range, stop at the range midpoint,
//   target targetR × risk, stop before target, else flat at the 4:00 close.
//
// R = target's R at the target, −1 at the stop, else (exit − entry) / risk. A gap through the
// stop counts −1R here; a real fill can be worse. No commissions or slippage. Pure.

import type { Bar } from "./types";
import { atr, rsi } from "./indicators";
import { FILTERS, lastIndexOnOrBefore, marketAt, marketBefore, ORB_VOLUME_X, passes, relativeStrength, SWING_VOLUME_X, volumeRatio, type FilterKey, type MarketSeries, type SignalContext } from "./market";
import { findSwingSetups, orbHit, orMidStop, SWING_SETUPS, type Session, type SwingSetup } from "./setups";

export interface TradeResult {
  date: string; // entry date
  entry: number;
  stop: number;
  target: number;
  outcome: "target" | "stop" | "time";
  exit: number;
  R: number;
  days: number; // bars held (swing) or 5-minute bars (intraday)
  ctx?: SignalContext; // market / relative strength / volume at the signal
}

export type FilteredRecords = Record<FilterKey, TrackRecord>;

/** The same trades, split by each confirmation filter (only trades where the filter passed). */
export function filterRecords(trades: TradeResult[], volumeX: number, kind?: string): FilteredRecords {
  return Object.fromEntries(FILTERS.map((f) => [f.key, summarize(trades.filter((t) => passes(t.ctx, f.key, volumeX)), kind)])) as FilteredRecords;
}

export interface TrackRecord {
  trades: number;
  target: number;
  stop: number;
  time: number; // still open at the time limit (or at the close, intraday)
  winRate: number; // share of trades with R > 0
  avgR: number;
  totalR: number;
  verdict: string; // one explainable line
  sample: "none" | "thin" | "ok";
  recent: TradeResult[]; // last few, newest first
}

export interface SwingParams {
  stopAtr: number;
  targetR: number;
  maxHoldDays: number;
}
export const DEFAULT_SWING_PARAMS: SwingParams = { stopAtr: 2, targetR: 2, maxHoldDays: 20 };

export interface Baseline {
  days: number; // how many start days
  upRate: number; // share up after maxHoldDays
  medianReturn: number;
  avgR: number; // the same trade plan entered on EVERY day: what a setup has to beat
  winRate: number;
}

export interface SwingBacktest {
  params: SwingParams;
  from?: string;
  to?: string;
  bars: number;
  bySetup: Record<SwingSetup, TrackRecord>;
  filtered?: Record<SwingSetup, FilteredRecords>; // present when market data was supplied
  baseline: Baseline;
}

const floorCents = (v: number) => Math.floor(v * 100 + 1e-9) / 100;
const r2 = (v: number) => Math.round(v * 100) / 100;
const MIN_SAMPLE = 10;

export function summarize(trades: TradeResult[], kind = "signal"): TrackRecord {
  const n = trades.length;
  const target = trades.filter((t) => t.outcome === "target").length;
  const stop = trades.filter((t) => t.outcome === "stop").length;
  const totalR = trades.reduce((s, t) => s + t.R, 0);
  const avgR = n ? totalR / n : 0;
  const winRate = n ? trades.filter((t) => t.R > 0).length / n : 0;
  const sample = n === 0 ? "none" : n < MIN_SAMPLE ? "thin" : "ok";
  let verdict: string;
  if (n === 0) verdict = `No past ${kind}s in this window.`;
  else {
    const edge = avgR >= 0.25 ? "Positive so far" : avgR > 0.05 ? "Slightly positive" : avgR > -0.05 ? "Break-even" : avgR > -0.25 ? "Slightly negative" : "Negative so far";
    verdict = `${edge}: ${avgR >= 0 ? "+" : ""}${avgR.toFixed(2)}R per trade over ${n} trade${n === 1 ? "" : "s"}` + (sample === "thin" ? " (too few to trust)" : "");
  }
  return {
    trades: n,
    target,
    stop,
    time: n - target - stop,
    winRate,
    avgR: r2(avgR),
    totalR: r2(totalR),
    verdict,
    sample,
    recent: trades.slice(-5).reverse(),
  };
}

/** Walk forward from entry index i; stop before target in each bar. */
function walkSwing(bars: Bar[], i: number, entry: number, stop: number, target: number, maxHold: number): TradeResult {
  const risk = entry - stop;
  const end = Math.min(bars.length - 1, i + maxHold);
  for (let j = i + 1; j <= end; j++) {
    const b = bars[j];
    if (b.low <= stop) return { date: bars[i].time, entry, stop, target, outcome: "stop", exit: stop, R: -1, days: j - i };
    if (b.high >= target) return { date: bars[i].time, entry, stop, target, outcome: "target", exit: target, R: (target - entry) / risk, days: j - i };
  }
  const exit = bars[end].close;
  return { date: bars[i].time, entry, stop, target, outcome: "time", exit, R: (exit - entry) / risk, days: end - i };
}

export function swingContext(bars: Bar[], i: number, market?: MarketSeries): SignalContext {
  return {
    marketUp: market ? marketAt(market, bars[i].time)?.above50 : undefined,
    rs: market ? relativeStrength(bars, i, market) : undefined,
    volX: volumeRatio(bars, i),
  };
}

export function swingBacktest(bars: Bar[], params: SwingParams = DEFAULT_SWING_PARAMS, market?: MarketSeries): SwingBacktest {
  const closes = bars.map((b) => b.close);
  const rs = rsi(closes);
  const atrs = atr(bars);
  const trades = Object.fromEntries(SWING_SETUPS.map((s) => [s.key, [] as TradeResult[]])) as Record<SwingSetup, TradeResult[]>;
  const busyUntil = Object.fromEntries(SWING_SETUPS.map((s) => [s.key, -1])) as Record<SwingSetup, number>;

  // Only signals with a full holding window behind them count: the last maxHold days are still open.
  const lastEntry = bars.length - 1 - params.maxHoldDays;
  for (let i = 29; i <= lastEntry; i++) {
    const a = atrs[i];
    if (!Number.isFinite(a) || a <= 0) continue;
    const found = findSwingSetups(closes.slice(0, i + 1), rs);
    if (!found?.tags.length) continue;
    const entry = closes[i];
    const stop = floorCents(entry - params.stopAtr * a);
    const risk = entry - stop;
    if (risk <= 0) continue;
    const target = r2(entry + params.targetR * risk);
    for (const tag of found.tags) {
      if (i <= busyUntil[tag]) continue;
      const t = walkSwing(bars, i, entry, stop, target, params.maxHoldDays);
      t.ctx = swingContext(bars, i, market);
      trades[tag].push(t);
      busyUntil[tag] = i + t.days;
    }
  }

  const fwd: number[] = [];
  let baseR = 0;
  let baseWins = 0;
  let baseN = 0;
  for (let i = 29; i <= lastEntry; i++) {
    fwd.push(closes[i + params.maxHoldDays] / closes[i] - 1);
    const a = atrs[i];
    if (!Number.isFinite(a) || a <= 0) continue;
    const stop = floorCents(closes[i] - params.stopAtr * a);
    if (closes[i] - stop <= 0) continue;
    const t = walkSwing(bars, i, closes[i], stop, r2(closes[i] + params.targetR * (closes[i] - stop)), params.maxHoldDays);
    baseR += t.R;
    baseWins += t.R > 0 ? 1 : 0;
    baseN++;
  }
  const sorted = [...fwd].sort((a, b) => a - b);
  return {
    params,
    from: bars[0]?.time,
    to: bars[bars.length - 1]?.time,
    bars: bars.length,
    bySetup: Object.fromEntries(SWING_SETUPS.map((s) => [s.key, summarize(trades[s.key])])) as Record<SwingSetup, TrackRecord>,
    filtered: market ? (Object.fromEntries(SWING_SETUPS.map((s) => [s.key, filterRecords(trades[s.key], SWING_VOLUME_X)])) as Record<SwingSetup, FilteredRecords>) : undefined,
    baseline: {
      days: fwd.length,
      upRate: fwd.length ? fwd.filter((x) => x > 0).length / fwd.length : 0,
      medianReturn: sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0,
      avgR: baseN ? r2(baseR / baseN) : 0,
      winRate: baseN ? baseWins / baseN : 0,
    },
  };
}

// ---------------------------------------------------------------- intraday

export interface OrbParams {
  orBars: number; // 3 = the first 15 minutes
  targetR: number;
}
export const DEFAULT_ORB_PARAMS: OrbParams = { orBars: 3, targetR: 2 };

export interface OrbBacktest {
  params: OrbParams;
  sessions: number; // full sessions replayed
  record: TrackRecord;
  filtered?: FilteredRecords; // present when market data was supplied
}

/** Context knowable at an intraday breakout: yesterday's market and RS, and the bar's volume vs the range. */
export function orbContext(s: Session, barIndex: number, orBars: number, market?: MarketSeries, daily?: Bar[]): SignalContext {
  const rangeVol = s.bars.slice(0, orBars).reduce((a, b) => a + b.volume, 0) / orBars;
  let rs: number | undefined;
  if (market && daily?.length) {
    const i = lastIndexOnOrBefore(daily, s.date);
    const prev = i === undefined ? undefined : daily[i].time === s.date ? i - 1 : i;
    if (prev !== undefined && prev >= 0) rs = relativeStrength(daily, prev, market);
  }
  return {
    marketUp: market ? marketBefore(market, s.date)?.above50 : undefined,
    rs,
    volX: rangeVol > 0 ? s.bars[barIndex].volume / rangeVol : undefined,
  };
}

/** The Time Machine's history replay on every FULL session (half days and gaps left out). */
export function orbBacktest(sessions: Session[], params: OrbParams = DEFAULT_ORB_PARAMS, market?: MarketSeries, daily?: Bar[]): OrbBacktest {
  const full = sessions.filter((s) => s.full);
  const trades: TradeResult[] = [];
  for (const s of full) {
    const hit = orbHit(s.bars, params.orBars);
    if (!hit) continue;
    const entry = hit.price;
    const stop = orMidStop(hit.orHigh, hit.orLow);
    const risk = entry - stop;
    if (risk <= 0) continue;
    const target = r2(entry + params.targetR * risk);
    let res: TradeResult | null = null;
    for (let k = hit.barIndex + 1; k < s.bars.length; k++) {
      const b = s.bars[k];
      if (b.low <= stop) {
        res = { date: s.date, entry, stop, target, outcome: "stop", exit: stop, R: -1, days: k - hit.barIndex };
        break;
      }
      if (b.high >= target) {
        res = { date: s.date, entry, stop, target, outcome: "target", exit: target, R: (target - entry) / risk, days: k - hit.barIndex };
        break;
      }
    }
    if (!res) {
      const exit = s.bars[s.bars.length - 1].close;
      res = { date: s.date, entry, stop, target, outcome: "time", exit, R: (exit - entry) / risk, days: s.bars.length - 1 - hit.barIndex };
    }
    res.ctx = orbContext(s, hit.barIndex, params.orBars, market, daily);
    trades.push(res);
  }
  return {
    params,
    sessions: full.length,
    record: summarize(trades, "breakout"),
    filtered: market ? filterRecords(trades, ORB_VOLUME_X, "breakout") : undefined,
  };
}
