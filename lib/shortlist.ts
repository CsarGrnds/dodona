// Pure: the day's shortlist, built BEFORE the open from daily closes, so the live runs only look for
// opening ranges in stocks that already pass the basics. Every rule is one plain reason, so a dropped
// stock always says why (the team's replays on 2026-11-18/19: most candidates were daily downtrends,
// thin volume or too quiet to pay IBKR's fees, and all were skips).
//
// A stock is kept when, on completed sessions:
//   - it has 50+ sessions of history
//   - the price fits one whole share in the account (min $5, max the account's max price)
//   - it trades enough: latest session's dollar volume >= $10M
//   - daily uptrend: close above its 20-day average, and the 20-day above the 50-day
//   - not stretched: close no more than 8% above its 20-day average (a breakout from there often fades)
//   - moves enough: average daily move over 20 sessions >= 1.2% (a 1.5% opening range needs room)
//   - stronger than the market: 20-day return above SPY's
// Ranked by that relative strength (best first).
import { sma } from "./indicators";

export interface ShortlistOpts {
  maxPrice: number;
  minPrice?: number; // default 5
  minDollarVolume?: number; // default 10M
  maxStretchPct?: number; // default 8
  minAvgMovePct?: number; // default 1.2
  spyReturn20?: number; // SPY's 20-day return, %; undefined = skip the relative-strength rule
}

export interface ShortlistPick {
  symbol: string;
  price: number;
  sma20: number;
  sma50: number;
  stretchPct: number; // % above the 20-day average
  avgMovePct: number; // average absolute daily change, last 20 sessions, %
  ret20: number; // 20-day return, %
  rs20?: number; // ret20 minus SPY's, points
  dollarVolume: number;
}

export type Screened = ShortlistPick | { symbol: string; why: string };

const r2 = (x: number) => Math.round(x * 100) / 100;
export const isPick = (x: Screened): x is ShortlistPick => !("why" in x);

/** 20-day return of a close series, % (null if too short). */
export function return20(closes: number[]): number | null {
  if (closes.length < 21) return null;
  const a = closes[closes.length - 21], b = closes[closes.length - 1];
  return a > 0 ? ((b - a) / a) * 100 : null;
}

/** Screen one stock from its completed daily closes (oldest first) and its latest session's volume. */
export function screenDaily(symbol: string, closes: number[], volume: number | undefined, o: ShortlistOpts): Screened {
  const c = closes.filter((x) => Number.isFinite(x) && x > 0);
  if (c.length < 50) return { symbol, why: "under 50 sessions of history" };
  const price = c[c.length - 1];
  if (price < (o.minPrice ?? 5)) return { symbol, why: "price under $5" };
  if (price > o.maxPrice) return { symbol, why: "one share costs more than the account allows" };
  const dollarVolume = (volume ?? 0) * price;
  if (dollarVolume < (o.minDollarVolume ?? 10_000_000)) return { symbol, why: "thin: under $10M traded a day" };
  const sma20 = sma(c, 20).at(-1)!, sma50 = sma(c, 50).at(-1)!;
  if (!(price > sma20 && sma20 > sma50)) return { symbol, why: "no daily uptrend (needs close > 20-day > 50-day average)" };
  const stretchPct = ((price - sma20) / sma20) * 100;
  if (stretchPct > (o.maxStretchPct ?? 8)) return { symbol, why: "stretched: over 8% above its 20-day average" };
  const moves = c.slice(-21).slice(1).map((x, i) => Math.abs((x - c[c.length - 21 + i]) / c[c.length - 21 + i]) * 100);
  const avgMovePct = moves.reduce((a, b) => a + b, 0) / moves.length;
  if (avgMovePct < (o.minAvgMovePct ?? 1.2)) return { symbol, why: "too quiet: moves under 1.2% a day" };
  const ret20 = return20(c)!;
  const rs20 = o.spyReturn20 === undefined ? undefined : ret20 - o.spyReturn20;
  if (rs20 !== undefined && rs20 <= 0) return { symbol, why: "weaker than SPY over 20 days" };
  return { symbol, price: r2(price), sma20: r2(sma20), sma50: r2(sma50), stretchPct: r2(stretchPct), avgMovePct: r2(avgMovePct), ret20: r2(ret20), ...(rs20 === undefined ? {} : { rs20: r2(rs20) }), dollarVolume: Math.round(dollarVolume) };
}

/** Best first: stronger than SPY, then more traded. */
export function rankShortlist(xs: ShortlistPick[]): ShortlistPick[] {
  return [...xs].sort((a, b) => (b.rs20 ?? b.ret20) - (a.rs20 ?? a.ret20) || b.dollarVolume - a.dollarVolume);
}

/** Group drop reasons into counts, for the report. */
export function countReasons(xs: Screened[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const x of xs) if (!isPick(x)) out[x.why] = (out[x.why] ?? 0) + 1;
  return out;
}
