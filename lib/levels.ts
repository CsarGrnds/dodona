// Support and resistance from the daily chart, the way a trader marks them by hand:
// swing highs and lows (a bar whose high/low is the extreme of the bars around it), grouped
// when they sit within half an ATR of each other. More touches = a level more people watch.
// Pure and shared.

import type { Bar } from "./types";

export interface Level {
  price: number; // average of the grouped pivots
  touches: number; // how many swing highs/lows formed there
  lastDate: string; // the most recent touch
  kind: "support" | "resistance";
  distancePct: number; // (level / price − 1), negative below the price
}

export interface ChartLevels {
  supports: Level[]; // nearest first, below the price
  resistances: Level[]; // nearest first, above the price
  lookbackDays: number;
}

const PIVOT_SPAN = 3; // bars on each side
const LOOKBACK = 250; // ~1 year

/** Swing highs and lows: bar i's high (low) is the highest (lowest) of bars i±span. */
export function pivots(bars: Bar[], span = PIVOT_SPAN): Array<{ i: number; price: number; type: "high" | "low" }> {
  const out: Array<{ i: number; price: number; type: "high" | "low" }> = [];
  for (let i = span; i < bars.length - span; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - span; j <= i + span; j++) {
      if (j === i) continue;
      if (bars[j].high >= bars[i].high) isHigh = false;
      if (bars[j].low <= bars[i].low) isLow = false;
    }
    if (isHigh) out.push({ i, price: bars[i].high, type: "high" });
    if (isLow) out.push({ i, price: bars[i].low, type: "low" });
  }
  return out;
}

/**
 * Levels around `price`. Pivots of either kind count (old resistance becomes support);
 * a group within `tolerance` (default 0.5 × ATR, at least 1% of price) is one level.
 */
export function supportResistance(bars: Bar[], price: number, atr?: number, opts: { lookback?: number; max?: number } = {}): ChartLevels {
  const lookback = opts.lookback ?? LOOKBACK;
  const max = opts.max ?? 3;
  const recent = bars.slice(-lookback);
  const tol = Math.max(atr && atr > 0 ? atr * 0.5 : 0, price * 0.01);
  const pts = pivots(recent).sort((a, b) => a.price - b.price);

  const groups: Array<{ prices: number[]; last: number }> = [];
  for (const p of pts) {
    const g = groups[groups.length - 1];
    if (g && p.price - g.prices[0] <= tol) {
      g.prices.push(p.price);
      g.last = Math.max(g.last, p.i);
    } else groups.push({ prices: [p.price], last: p.i });
  }

  const levels: Level[] = groups.map((g) => {
    const lvl = g.prices.reduce((s, v) => s + v, 0) / g.prices.length;
    return {
      price: Math.round(lvl * 100) / 100,
      touches: g.prices.length,
      lastDate: recent[g.last].time,
      kind: lvl < price ? "support" : "resistance",
      distancePct: lvl / price - 1,
    };
  });
  // A level hugging the price (within the tolerance) is the one being tested: keep it on the side it came from.
  const supports = levels.filter((l) => l.price < price).sort((a, b) => b.price - a.price).slice(0, max);
  const resistances = levels
    .filter((l) => l.price >= price)
    .map((l) => ({ ...l, kind: "resistance" as const }))
    .sort((a, b) => a.price - b.price)
    .slice(0, max);
  return { supports, resistances, lookbackDays: recent.length };
}

/** A single swing high/low is noise; a level needs at least this many touches to count in the plan checks. */
export const MIN_TOUCHES = 2;

/** The first resistance strictly between entry and target, if any: a level the trade has to break first. */
export function resistanceBefore(levels: ChartLevels, entry: number, target: number, minTouches = MIN_TOUCHES): Level | undefined {
  return levels.resistances.find((l) => l.touches >= minTouches && l.price > entry && l.price < target);
}

/** The nearest support between stop and entry: a stop below it has a floor in front of it. */
export function supportAbove(levels: ChartLevels, stop: number, entry: number, minTouches = MIN_TOUCHES): Level | undefined {
  return levels.supports.find((l) => l.touches >= minTouches && l.price > stop && l.price < entry);
}
