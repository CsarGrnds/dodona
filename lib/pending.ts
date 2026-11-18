// Pure: opening ranges that have FORMED but not BROKEN yet: the candidates a buy-stop needs. The
// /trader-scanner skill lists breakouts that already happened (too late for an order that waits at
// IBKR); this finds the ones still coiling under their range high, so the trigger can sit there.
//
// Rules (the same opening range as /trader-entry: the first 15 minutes, a breakout is a completed
// 5-minute bar CLOSING above the range high):
//   - the range has formed (3 completed bars) and no completed bar since has closed above its high
//   - the last price is within `maxBelowPct` of the range high (close enough to break today)
//   - the last price is above VWAP (buyers in control) and above the range's midpoint
//   - volume so far vs the same bars on past sessions (relative volume) is reported and ranked
import type { IntradayBar } from "./setups";
import { nyClock } from "./setups";

export interface PendingRange {
  symbol: string;
  orHigh: number;
  orLow: number;
  orMid: number;
  last: number;
  vwap: number;
  belowHighPct: number; // how far the last price is under the range high, %
  relVolume?: number; // today's volume so far vs the same bars on the last 20 sessions
  rangePct: number; // the range's width, % of its high
  bars: number; // completed bars today
}

export interface PendingOpts {
  nowMs: number;
  orBars?: number; // 3 x 5 minutes = 15
  maxBelowPct?: number; // default 1.5%
  minRangePct?: number; // too narrow a range can't pay for its fees: the risk per share is tiny (default 1.5%)
  maxRangePct?: number; // too wide: the risk per share is too big (default 6%)
}

const r2 = (x: number) => Math.round(x * 100) / 100;

/**
 * Ranges narrower than this are skipped: with a small account (about $150 a trade) a 1% range risks
 * about $1.50 at its low, which IBKR's fees eat. 1.5% leaves room for the trade to pay for itself.
 */
export const MIN_RANGE_PCT = 1.5;

/** Check one stock's 5-minute bars (several sessions, oldest first). Returns the range or why not. */
export function pendingRange(symbol: string, bars: IntradayBar[], o: PendingOpts): PendingRange | { symbol: string; why: string } {
  const orBars = o.orBars ?? 3;
  const { date } = nyClock(o.nowMs);
  const regular = bars.filter((b) => {
    const k = nyClock(b.t);
    return k.minute >= 570 && k.minute < 960;
  });
  // only completed bars: a bar is done 5 minutes after it starts
  const today = regular.filter((b) => nyClock(b.t).date === date && b.t + 5 * 60_000 <= o.nowMs);
  if (today.length < orBars) return { symbol, why: "the opening range hasn't formed yet" };
  const or = today.slice(0, orBars);
  const orHigh = Math.max(...or.map((b) => b.high));
  const orLow = Math.min(...or.map((b) => b.low));
  const after = today.slice(orBars);
  if (after.some((b) => b.close > orHigh)) return { symbol, why: "already broke out" };
  const last = today[today.length - 1].close;
  let pv = 0, vol = 0;
  for (const b of today) {
    pv += ((b.high + b.low + b.close) / 3) * b.volume;
    vol += b.volume;
  }
  const vwap = vol > 0 ? pv / vol : last;
  const belowHighPct = ((orHigh - last) / orHigh) * 100;
  const rangePct = ((orHigh - orLow) / orHigh) * 100;
  const orMid = (orHigh + orLow) / 2;
  if (belowHighPct > (o.maxBelowPct ?? 1.5)) return { symbol, why: `${r2(belowHighPct)}% under the range high` };
  if (last < vwap) return { symbol, why: "below VWAP" };
  if (last < orMid) return { symbol, why: "in the lower half of the range" };
  if (rangePct < (o.minRangePct ?? MIN_RANGE_PCT)) return { symbol, why: "range too narrow" };
  if (rangePct > (o.maxRangePct ?? 6)) return { symbol, why: "range too wide" };
  const past = new Map<string, number>();
  for (const b of regular) {
    const k = nyClock(b.t);
    if (k.date === date) continue;
    // the same part of the day as today's completed bars
    if (k.minute < 570 + today.length * 5) past.set(k.date, (past.get(k.date) ?? 0) + b.volume);
  }
  const prior = [...past.values()].slice(-20);
  const avg = prior.length ? prior.reduce((a, b) => a + b, 0) / prior.length : 0;
  return { symbol, orHigh: r2(orHigh), orLow: r2(orLow), orMid: r2(orMid), last: r2(last), vwap: r2(vwap), belowHighPct: r2(belowHighPct), relVolume: avg > 0 ? r2(vol / avg) : undefined, rangePct: r2(rangePct), bars: today.length };
}

export const isPending = (x: PendingRange | { why: string }): x is PendingRange => !("why" in x);

/** Best first: stronger relative volume, then closer to the trigger. */
export function rankPending(xs: PendingRange[]): PendingRange[] {
  return [...xs].sort((a, b) => (b.relVolume ?? 0) - (a.relVolume ?? 0) || a.belowHighPct - b.belowHighPct);
}
