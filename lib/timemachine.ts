// Time Machine for a swing plan, ported from /trader-timemachine and adapted to daily bars.
//   The skill rebuilds the rest of ONE session 10,000 times from the stock's own 5-minute bars.
//   Here a replay rebuilds the next `days` sessions from the stock's own last year of DAILY bars:
//   each day is a random past day's (open, high, low, close) as ratios to its previous close,
//   scaled to the current price. Same rules as the skill: the stop is checked before the target
//   in every bar (a bar that touches both counts as the stop), a gap through the stop still
//   counts −1R, "neither" = still open after `days`, and the same verdict thresholds.
// Seeded, so the same plan and data always give the same numbers. Pure and shared.
// A simulation built from the last year is not a prediction: earnings and news can do what the
// last year never did.

import type { Bar } from "./types";

export const REPLAYS = 10_000;
export const SEED = 19;
const COIN_FLIP = 0.05;
const STRONG = 0.15;
const MANY_NEITHER = 0.4;
const POOL_DAYS = 250;

export type Ratio = [o: number, h: number, l: number, c: number];

/** Each past day as (open, high, low, close) / previous close. */
export function dailyPool(bars: Bar[], days = POOL_DAYS): Ratio[] {
  const b = bars.slice(-(days + 1));
  const pool: Ratio[] = [];
  for (let i = 1; i < b.length; i++) {
    const pc = b[i - 1].close;
    if (pc > 0) pool.push([b[i].open / pc, b[i].high / pc, b[i].low / pc, b[i].close / pc]);
  }
  return pool;
}

/** mulberry32: small, fast, seedable. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface TimeMachineResult {
  replays: number;
  days: number;
  poolDays: number;
  entry: number;
  stop: number;
  target: number;
  rAtTarget: number;
  pTarget: number;
  pStop: number;
  pNeither: number;
  pGreen: number; // target first, or above the entry when time ran out
  avgR: number;
  // the price after `days` sessions, among the replays still open (undefined when none)
  medianClose?: number;
  p5Close?: number;
  p95Close?: number;
  medianDaysToExit?: number; // among replays that hit a side
  verdict: string;
  notes: string[];
}

export function simulate(pool: Ratio[], plan: { entry: number; stop: number; target: number }, days: number, replays = REPLAYS, seed = SEED): TimeMachineResult | null {
  const { entry, stop, target } = plan;
  const risk = entry - stop;
  if (!(risk > 0) || !(target > entry) || pool.length < 20 || days < 1) return null;
  const rTarget = Math.round(((target - entry) / risk) * 1e4) / 1e4;
  const rand = rng(seed);
  let nT = 0;
  let nS = 0;
  let green = 0;
  let sumR = 0;
  const closes: number[] = [];
  const exitDays: number[] = [];
  for (let n = 0; n < replays; n++) {
    let p = entry;
    let outcome: "target" | "stop" | undefined;
    for (let d = 1; d <= days; d++) {
      const [, h, l, c] = pool[Math.floor(rand() * pool.length)];
      const hi = p * h;
      const lo = p * l;
      if (lo <= stop) outcome = "stop"; // checked first: a bar that touches both is a loss
      else if (hi >= target) outcome = "target";
      p = p * c;
      if (outcome) {
        exitDays.push(d);
        break;
      }
    }
    if (outcome === "target") {
      nT++;
      green++;
      sumR += rTarget;
    } else if (outcome === "stop") {
      nS++;
      sumR -= 1;
    } else {
      if (p > entry) green++;
      sumR += (p - entry) / risk;
      closes.push(p);
    }
  }
  closes.sort((a, b) => a - b);
  exitDays.sort((a, b) => a - b);
  const q = (a: number[], f: number) => a[Math.min(a.length - 1, Math.floor(f * a.length))];
  const res: TimeMachineResult = {
    replays,
    days,
    poolDays: pool.length,
    entry,
    stop,
    target,
    rAtTarget: rTarget,
    pTarget: nT / replays,
    pStop: nS / replays,
    pNeither: (replays - nT - nS) / replays,
    pGreen: green / replays,
    avgR: sumR / replays,
    medianClose: closes.length ? q(closes, 0.5) : undefined,
    p5Close: closes.length ? q(closes, 0.05) : undefined,
    p95Close: closes.length ? q(closes, 0.95) : undefined,
    medianDaysToExit: exitDays.length ? q(exitDays, 0.5) : undefined,
    verdict: "",
    notes: [],
  };
  res.verdict = verdict(res);
  res.notes = verdictNotes(res);
  return res;
}

/** (gap, share, breakEven): the target's share of replays that hit a side, minus the share that breaks even at its R. */
export function lean(mc: Pick<TimeMachineResult, "pTarget" | "pStop" | "rAtTarget">): { gap: number; share: number; even: number } | null {
  const { pTarget: pt, pStop: ps } = mc;
  if (pt + ps <= 0) return null;
  const r = mc.rAtTarget || 1;
  const share = pt / (pt + ps);
  const even = 1 / (1 + r);
  return { gap: share - even, share, even };
}

export type Lean = "strong-target" | "target" | "even" | "stop" | "strong-stop" | "none";

export function leanKind(mc: Pick<TimeMachineResult, "pTarget" | "pStop" | "rAtTarget">): Lean {
  const l = lean(mc);
  if (!l) return "none";
  if (Math.abs(l.gap) < COIN_FLIP) return "even";
  if (Math.abs(l.gap) < STRONG) return l.gap > 0 ? "target" : "stop";
  return l.gap > 0 ? "strong-target" : "strong-stop";
}

const pc = (x: number) => `${(100 * x).toFixed(1)}%`;

export function verdict(mc: TimeMachineResult): string {
  const l = lean(mc);
  if (!l) return `No replay reached the target or the stop within ${mc.days} sessions: the price then decides every one.`;
  const r = mc.rAtTarget || 1;
  const oneR = Math.abs(r - 1) < 0.005;
  const k = leanKind(mc);
  const head =
    k === "even" ? (oneR ? "Close to a coin flip" : "Close to break-even") : k === "target" ? "Leans toward the target" : k === "stop" ? "Leans toward the stop" : k === "strong-target" ? "Strongly toward the target" : "Strongly toward the stop";
  const odds = `target first ${pc(mc.pTarget)} vs stop first ${pc(mc.pStop)}`;
  if (oneR) return `${head}: ${odds}.`;
  return `${head}: at ${+r.toFixed(2)}R the target has to come first in ${(100 * l.even).toFixed(0)}% of the replays that hit one side; it did in ${(100 * l.share).toFixed(0)}% (${odds}).`;
}

export function verdictNotes(mc: TimeMachineResult): string[] {
  const notes: string[] = [];
  const l = lean(mc);
  if (mc.pNeither > MANY_NEITHER && l) notes.push(`${pc(mc.pNeither)} of the replays hit neither within ${mc.days} sessions; the price then decides those.`);
  if (l && Math.abs(l.gap) >= COIN_FLIP && mc.avgR !== 0 && mc.avgR > 0 !== l.gap > 0)
    notes.push(`Average R is ${mc.avgR >= 0 ? "+" : ""}${mc.avgR.toFixed(3)} all the same: the replays that hit neither pull it the other way.`);
  return notes;
}
