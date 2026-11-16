// Market context, relative strength and volume confirmation: the checks a trader makes before
// trusting a setup. Pure and shared.
//   market   — SPY above its 50-day (and 200-day) average: "don't buy breakouts in a falling market"
//   relative — the stock's 3-month return minus SPY's: favor stocks stronger than the market
//   volume   — swing: the setup day's volume vs its 20-day average (≥ 1.5× = confirmed)
//              intraday: the breakout bar vs the opening-range bars' average (trader-entry's
//              --min-volume-x; the 9:30 bar carries the opening auction, so 1.0× is already high)

import type { Bar } from "./types";

export const MARKET_SYMBOL = "SPY";
export const RS_DAYS = 63; // ~3 months
export const SWING_VOLUME_X = 1.5;
export const ORB_VOLUME_X = 1.0;

export interface MarketContext {
  symbol: string;
  date: string;
  close: number;
  sma50?: number;
  sma200?: number;
  above50: boolean;
  above200?: boolean;
  return3m?: number;
  trend: "up" | "down" | "mixed";
  detail: string;
}

/** Precomputed per-day market series so backtests can look up the context on any past date. */
export interface MarketSeries {
  index: Map<string, number>; // date → bar index
  bars: Bar[];
  sma50: number[];
  sma200: number[];
}

export function marketSeries(bars: Bar[]): MarketSeries {
  return { index: new Map(bars.map((b, i) => [b.time, i])), bars, sma50: rollingMean(bars.map((b) => b.close), 50), sma200: rollingMean(bars.map((b) => b.close), 200) };
}

/** The market context as of `date` (or the latest bar on or before it). */
export function marketAt(ms: MarketSeries, date?: string, symbol = MARKET_SYMBOL): MarketContext | undefined {
  let i = date === undefined ? ms.bars.length - 1 : ms.index.get(date) ?? lastIndexOnOrBefore(ms.bars, date);
  if (i === undefined || i < 0) return undefined;
  const close = ms.bars[i].close;
  const s50 = fin(ms.sma50[i]);
  const s200 = fin(ms.sma200[i]);
  if (s50 === undefined) return undefined;
  const above50 = close > s50;
  const above200 = s200 === undefined ? undefined : close > s200;
  const trend = above50 && above200 !== false ? "up" : !above50 && above200 === false ? "down" : "mixed";
  const ret = i >= RS_DAYS ? close / ms.bars[i - RS_DAYS].close - 1 : undefined;
  return {
    symbol,
    date: ms.bars[i].time,
    close,
    sma50: s50,
    sma200: s200,
    above50,
    above200,
    return3m: ret,
    trend,
    detail: `${symbol} ${close.toFixed(2)} vs 50d ${s50.toFixed(2)}${s200 !== undefined ? `, 200d ${s200.toFixed(2)}` : ""}`,
  };
}

/** The context as of the last close strictly BEFORE `date`: what was knowable during that session. */
export function marketBefore(ms: MarketSeries, date: string, symbol = MARKET_SYMBOL): MarketContext | undefined {
  const i = lastIndexOnOrBefore(ms.bars, date);
  if (i === undefined) return undefined;
  const prev = ms.bars[i].time === date ? i - 1 : i;
  return prev >= 0 ? marketAt(ms, ms.bars[prev].time, symbol) : undefined;
}

/** Stock 3-month return minus the market's, on the stock's bar `i` (matched by date). */
export function relativeStrength(stock: Bar[], i: number, ms: MarketSeries): number | undefined {
  if (i < RS_DAYS) return undefined;
  const m = marketAt(ms, stock[i].time);
  if (m?.return3m === undefined) return undefined;
  return stock[i].close / stock[i - RS_DAYS].close - 1 - m.return3m;
}

/** Bar i's volume vs the average of the 20 bars before it. */
export function volumeRatio(bars: Bar[], i: number, lookback = 20): number | undefined {
  if (i < lookback) return undefined;
  let s = 0;
  for (let j = i - lookback; j < i; j++) s += bars[j].volume;
  const avg = s / lookback;
  return avg > 0 ? bars[i].volume / avg : undefined;
}

export interface SignalContext {
  marketUp?: boolean; // SPY above its 50-day on the signal date
  rs?: number; // relative strength (fraction)
  volX?: number; // volume ratio
}

export type FilterKey = "market" | "rs" | "volume" | "all";

export const FILTERS: Array<{ key: FilterKey; label: string; rule: string }> = [
  { key: "market", label: "Market up", rule: `${MARKET_SYMBOL} above its 50-day average on the signal day` },
  { key: "rs", label: "Stronger than market", rule: `3-month return above ${MARKET_SYMBOL}'s` },
  { key: "volume", label: "Volume confirmed", rule: "Swing: ≥1.5× the 20-day average volume. Intraday: breakout bar ≥1.0× the opening-range bars' average" },
  { key: "all", label: "All three", rule: "Market up, stronger than the market and volume confirmed" },
];

export function passes(ctx: SignalContext | undefined, key: FilterKey, volumeX: number): boolean {
  if (!ctx) return false;
  const m = ctx.marketUp === true;
  const r = ctx.rs !== undefined && ctx.rs > 0;
  const v = ctx.volX !== undefined && ctx.volX >= volumeX;
  return key === "market" ? m : key === "rs" ? r : key === "volume" ? v : m && r && v;
}

// ---------------------------------------------------------------- helpers

function rollingMean(v: number[], n: number): number[] {
  const out = new Array(v.length).fill(NaN);
  let s = 0;
  for (let i = 0; i < v.length; i++) {
    s += v[i];
    if (i >= n) s -= v[i - n];
    if (i >= n - 1) out[i] = s / n;
  }
  return out;
}

export function lastIndexOnOrBefore(bars: Bar[], date: string): number | undefined {
  let lo = 0;
  let hi = bars.length - 1;
  let ans: number | undefined;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].time <= date) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

const fin = (v: number | undefined) => (v !== undefined && Number.isFinite(v) ? v : undefined);
