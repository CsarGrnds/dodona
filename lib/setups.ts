// Chart setups, ported from the day-trader skills so Dodona and /trader-scanner agree:
//   swing    — trader-scanner's daily setups (find_setups in scan.py), on daily closes
//   intraday — the opening-range breakout (orb_hit in scan.py / trader-entry): the first
//              completed 5-minute bar after the opening range that CLOSES above its high
// Pure and shared. A setup is a chart that matches a rule, not a recommendation.

import { rsi } from "./indicators";

export type SwingSetup = "breakout_20d" | "bull_flag" | "reclaim_ma20" | "oversold" | "oversold_bounce";

export const SWING_SETUPS: Array<{ key: SwingSetup; label: string; rule: string }> = [
  { key: "breakout_20d", label: "20-day breakout", rule: "Close above the highest close of the previous 20 days" },
  { key: "bull_flag", label: "Bull flag", rule: "Up >10% from 15 to 5 days ago, then a tight 5-day range (<5%)" },
  { key: "reclaim_ma20", label: "Reclaimed 20-day avg", rule: "Yesterday below the 20-day average, today above it" },
  { key: "oversold", label: "Oversold", rule: "RSI(14) under 30" },
  { key: "oversold_bounce", label: "Oversold bounce", rule: "RSI(14) was under 30 yesterday and today closed higher" },
];
export const SETUP_LABEL = Object.fromEntries(SWING_SETUPS.map((s) => [s.key, s.label])) as Record<SwingSetup, string>;

export const MIN_DAILY_BARS = 30;

export interface SwingNumbers {
  rsi?: number;
  rsiPrev?: number;
  high20: number;
  ma20: number;
  runPct: number;
  range5Pct: number;
}

/**
 * Setups on the LAST close of `closes` (oldest first). `rsiSeries` is optional: pass the
 * precomputed Wilder RSI of the full series (prefix-consistent) to avoid recomputing it.
 */
export function findSwingSetups(closes: number[], rsiSeries?: number[]): { tags: SwingSetup[]; numbers: SwingNumbers } | null {
  const n = closes.length;
  if (n < MIN_DAILY_BARS) return null;
  const c = closes;
  const last = c[n - 1];
  const hi20 = Math.max(...c.slice(n - 21, n - 1));
  const ma20 = avg(c.slice(n - 20));
  const ma20Prev = avg(c.slice(n - 21, n - 1));
  const run = c[n - 6] / c[n - 16] - 1;
  const last5 = c.slice(n - 5);
  const rng5 = (Math.max(...last5) - Math.min(...last5)) / last;
  const rs = rsiSeries ?? rsi(c);
  const r = fin(rs[n - 1]);
  const rPrev = fin(rs[n - 2]);

  const tags: SwingSetup[] = [];
  if (last > hi20) tags.push("breakout_20d");
  if (run > 0.1 && rng5 < 0.05) tags.push("bull_flag");
  if (c[n - 2] < ma20Prev && last > ma20) tags.push("reclaim_ma20");
  if (r !== undefined && r < 30) tags.push("oversold");
  if (rPrev !== undefined && rPrev < 30 && last > c[n - 2]) tags.push("oversold_bounce");
  return { tags, numbers: { rsi: r, rsiPrev: rPrev, high20: hi20, ma20, runPct: run * 100, range5Pct: rng5 * 100 } };
}

// ---------------------------------------------------------------- intraday

export interface IntradayBar {
  t: number; // bar start, epoch ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Session {
  date: string; // YYYY-MM-DD, New York
  bars: IntradayBar[]; // regular-hours 5-minute bars, slot k starts at 9:30 + 5k
  full: boolean; // all 78 bars (9:30 to 4:00) present
}

export const BAR_MIN = 5;
export const OPEN_MIN = 9 * 60 + 30;
export const CLOSE_MIN = 16 * 60;
export const FULL_SESSION_BARS = (CLOSE_MIN - OPEN_MIN) / BAR_MIN; // 78

const nyFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

/** New York calendar date and minutes after midnight for an epoch-ms timestamp. */
export function nyClock(ms: number): { date: string; minute: number } {
  const p = Object.fromEntries(nyFmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minute: Number(p.hour) * 60 + Number(p.minute) };
}

export const clockLabel = (minute: number) => {
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
};

/**
 * Group 5-minute bars into regular-hours sessions, oldest first. Off-grid ticks, pre/post
 * market and the 4:00 closing print are dropped (as scan.py's session_bars does). Bars still
 * forming at `nowMs` are dropped too.
 */
export function splitSessions(bars: IntradayBar[], nowMs = Date.now()): Session[] {
  const byDay = new Map<string, Map<number, IntradayBar>>();
  for (const b of bars) {
    if (!Number.isFinite(b.close)) continue;
    if (b.t + BAR_MIN * 60_000 > nowMs) continue;
    const { date, minute } = nyClock(b.t);
    if (minute < OPEN_MIN || minute >= CLOSE_MIN || (minute - OPEN_MIN) % BAR_MIN) continue;
    const slot = (minute - OPEN_MIN) / BAR_MIN;
    if (!byDay.has(date)) byDay.set(date, new Map());
    byDay.get(date)!.set(slot, b);
  }
  return [...byDay.keys()].sort().map((date) => {
    const m = byDay.get(date)!;
    const slots = [...m.keys()].sort((a, b) => a - b);
    // keep the contiguous run from the open; a gap means the rest can't be trusted bar by bar
    const out: IntradayBar[] = [];
    for (let k = 0; k < slots.length && slots[k] === k; k++) out.push(m.get(k)!);
    return { date, bars: out, full: out.length === FULL_SESSION_BARS };
  });
}

export interface OrbHit {
  barIndex: number; // the bar whose close broke out
  price: number; // that close: the entry
  atMinute: number; // when that bar closed (NY minutes)
  orHigh: number;
  orLow: number;
  pctOver: number;
}

/** First completed bar after the first `orBars` bars to CLOSE above the opening-range high. */
export function orbHit(bars: IntradayBar[], orBars = 3, lastIndex = bars.length - 1): OrbHit | null {
  if (bars.length <= orBars) return null;
  const range = bars.slice(0, orBars);
  const orHigh = Math.max(...range.map((b) => b.high));
  const orLow = Math.min(...range.map((b) => b.low));
  for (let k = orBars; k <= Math.min(lastIndex, bars.length - 1); k++) {
    const b = bars[k];
    if (b.close > orHigh) {
      return {
        barIndex: k,
        price: round2(b.close),
        atMinute: OPEN_MIN + BAR_MIN * (k + 1),
        orHigh: round2(orHigh),
        orLow: round2(orLow),
        pctOver: (b.close / orHigh - 1) * 100,
      };
    }
  }
  return null;
}

/** Opening-range midpoint, rounded down to the cent (trader-exit's default stop). */
export const orMidStop = (orHigh: number, orLow: number) => Math.floor(((orHigh + orLow) / 2) * 100 + 1e-9) / 100;

// ---------------------------------------------------------------- helpers

const avg = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
const fin = (v: number | undefined) => (v !== undefined && Number.isFinite(v) ? v : undefined);
const round2 = (v: number) => Math.round(v * 100) / 100;
