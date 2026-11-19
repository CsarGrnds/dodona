// Daily prep: what to do with the account before the bell. Pure and shared, no I/O.
//
//   stops     — a suggested protective stop for each holding (an ATR trailing stop, a strong
//               support, or break-even, whichever is highest), compared with the stop order
//               actually resting at IBKR: raise it, keep it, it's too tight, or there is none.
//               Stops only ever move up.
//   discounts — is a lower price a discount (a pullback to support in an uptrend) or a falling
//               knife (a downtrend)? Each verdict lists the rules that fired.
//   buy limits — for resting BUY limit orders: how far the price has to fall, and whether the
//               limit sits on a support level.
//
// Every number comes from the daily chart. Dodona never places, changes or cancels an order:
// the user makes the change in IBKR.

import { MIN_TOUCHES, type ChartLevels, type Level } from "./levels";
import type { SwingSetup } from "./setups";
import type { Bar, Indicators } from "./types";

export const TRAIL_LOOKBACK = 22; // ~1 month of sessions for the highest high
export const TRAIL_ATR = 3; // chandelier: highest high − 3 × ATR
export const TIGHT_TRAIL_ATR = 2; // when the stock is stretched far above its 20-day average
export const EXTENDED_ATR = 3; // price this many ATRs above the 20-day average = extended
export const EXTENDED_RSI = 75;
export const SUPPORT_BUFFER_ATR = 0.5; // a stop sits half an ATR under the support, not on it
export const MIN_STOP_ATR = 1; // never suggest a stop within 1 ATR of the price (daily noise)
export const TIGHT_STOP_ATR = 0.5; // a current stop closer than this is likely to be shaken out
export const BREAKEVEN_ATR = 3; // once the gain is 3 ATRs, the stop is at least the average cost
export const TRAIL_ATR_FALLBACK = 2; // when the trail is already crossed and no support is near
export const RAISE_MIN_ATR = 0.25; // smaller raises aren't worth an order change
export const EARNINGS_DAYS = 7; // trading days
export const AT_SUPPORT_ATR = 1; // within 1 ATR above a strong support = "at support"
export const PULLBACK_RSI = 40;

export type OrderKind = "stop" | "stop-limit" | "trail" | "limit" | "other";

/** An open order as read from IBKR (normalized; see lib/data/ibkr.ts openOrders). */
export interface OpenOrder {
  orderId: string;
  conid?: number; // IBKR's contract id, needed to change the order
  ticker: string;
  side: "BUY" | "SELL";
  kind: OrderKind;
  stop?: number; // trigger price for stop / stop-limit / trail
  limit?: number;
  qty: number; // remaining
  tif: string;
  status: string;
  desc: string;
}

const floorCents = (v: number) => Math.floor(v * 100 + 1e-9) / 100;
const ceilCents = (v: number) => Math.ceil(v * 100 - 1e-9) / 100;
const usd = (v: number) => `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (v: number) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}%`;

export type Trend = "up" | "down" | "mixed";

export function trendOf(price: number, ind: Pick<Indicators, "sma50" | "sma200">): Trend {
  const { sma50, sma200 } = ind;
  if (!sma200 || !sma50) return "mixed";
  if (price > sma200 && sma50 > sma200) return "up";
  if (price < sma200 && sma50 < sma200) return "down";
  return "mixed";
}

/** Stretched far above its 20-day average or RSI very high: trail tighter. */
export function isExtended(price: number, ind: Pick<Indicators, "sma20" | "rsi14" | "atr14">): boolean {
  const { sma20, rsi14, atr14 } = ind;
  return (rsi14 !== undefined && rsi14 >= EXTENDED_RSI) || (!!sma20 && !!atr14 && (price - sma20) / atr14 >= EXTENDED_ATR);
}

export interface StopCandidate {
  key: "trail" | "support" | "breakeven";
  price: number;
  detail: string;
}

export interface StopSuggestion {
  price: number;
  basis: StopCandidate["key"] | "floor" | "fallback";
  candidates: StopCandidate[];
  extended: boolean;
  trailBroken: boolean; // already fell past the trailing stop from its 22-day high
  why: string;
}

/** The strongest nearby support: the nearest one below the price with at least MIN_TOUCHES. */
export function strongSupport(levels: ChartLevels | undefined, below: number): Level | undefined {
  return levels?.supports.find((l) => l.touches >= MIN_TOUCHES && l.price < below);
}

/**
 * The protective stop the rules suggest for a long holding: the highest of
 *   trail     highest high of the last 22 sessions − 3 × ATR (2 × when extended)
 *   support   the nearest strong support − 0.5 × ATR
 *   breakeven the average cost, once the price is 3 ATRs above it
 * but never within 1 ATR of the price. When the stock already fell past the trail, the trail is
 * dropped (support or break-even, else 2 × ATR under the price). Rounded down to the cent.
 */
export function suggestStop(bars: Bar[], price: number, ind: Indicators, levels?: ChartLevels, avgCost?: number): StopSuggestion | null {
  const atr = ind.atr14;
  if (!atr || !(atr > 0) || !(price > 0) || bars.length < TRAIL_LOOKBACK) return null;
  const extended = isExtended(price, ind);
  const mult = extended ? TIGHT_TRAIL_ATR : TRAIL_ATR;
  const hh = Math.max(...bars.slice(-TRAIL_LOOKBACK).map((b) => b.high), price);
  const ceiling = floorCents(price - MIN_STOP_ATR * atr);
  const trail = floorCents(hh - mult * atr);
  // Already more than `mult` ATRs off the high: a trailing stop would have been crossed, so it
  // can't anchor a new stop. Fall back on support / break-even, else 2 ATRs under the price.
  const trailBroken = trail >= price;
  const cands: StopCandidate[] = trailBroken
    ? []
    : [{ key: "trail", price: trail, detail: `22-day high ${usd(hh)} − ${mult} × ATR ${atr.toFixed(2)}${extended ? " (tighter: extended)" : ""}` }];
  const sup = strongSupport(levels, price - SUPPORT_BUFFER_ATR * atr);
  if (sup) cands.push({ key: "support", price: floorCents(sup.price - SUPPORT_BUFFER_ATR * atr), detail: `Support ${usd(sup.price)} (${sup.touches} touches) − ½ ATR` });
  if (avgCost && avgCost > 0 && price - avgCost >= BREAKEVEN_ATR * atr) {
    cands.push({ key: "breakeven", price: ceilCents(avgCost), detail: `Up ${((price - avgCost) / atr).toFixed(1)} ATRs from your cost ${usd(avgCost)}: protect break-even` });
  }
  const offHigh = `Down ${((hh - price) / atr).toFixed(1)} ATRs from its 22-day high ${usd(hh)}, past the ${mult}-ATR trailing stop`;
  if (!cands.length) {
    const p = floorCents(price - TRAIL_ATR_FALLBACK * atr);
    return { price: p, basis: "fallback", candidates: cands, extended, trailBroken, why: `${offHigh}, and no support with 2+ touches nearby: ${TRAIL_ATR_FALLBACK} × ATR ${atr.toFixed(2)} under the price` };
  }
  const best = cands.reduce((a, b) => (b.price > a.price ? b : a));
  const prefix = trailBroken ? `${offHigh}. ` : "";
  if (best.price > ceiling) {
    return { price: ceiling, basis: "floor", candidates: cands, extended, trailBroken, why: `${prefix}${best.detail} is within 1 ATR of the price, so 1 ATR below it: ${usd(ceiling)}` };
  }
  return { price: best.price, basis: best.key, candidates: cands, extended, trailBroken, why: `${prefix}${best.detail}` };
}

export type StopVerdict = "raise" | "keep" | "tight" | "missing" | "above" | "partial" | "hold" | "below-cost";

/**
 * The user's own trading rules, applied on top of the chart rules.
 *   neverSellAtLoss — no stop below the average cost. A position under water (or less than
 *   1 ATR above its cost) is held until it recovers; once the price is 1 ATR above the cost, the
 *   stop is at least the cost, so a stop-out is never a loss.
 */
export interface TradingRules {
  neverSellAtLoss: boolean;
}
export const DEFAULT_RULES: TradingRules = { neverSellAtLoss: true };
export const RULE_LABELS: Record<keyof TradingRules, { label: string; detail: string }> = {
  neverSellAtLoss: {
    label: "Never sell at a loss",
    detail: "No stop below your average cost. Under water: hold until it's back above cost. Once the price is 1 ATR above cost, the stop is at least your cost.",
  },
};
export function normalizeRules(raw: Partial<TradingRules> | null | undefined): TradingRules {
  return { neverSellAtLoss: typeof raw?.neverSellAtLoss === "boolean" ? raw.neverSellAtLoss : DEFAULT_RULES.neverSellAtLoss };
}

export interface StopAdvice {
  verdict: StopVerdict;
  headline: string;
  detail: string;
  current?: number;
  suggested: number;
  riskNow?: number; // dollars lost if the current stop fills (negative = gain locked)
  riskAfter: number; // with the suggested stop (when raising or setting)
  coveredQty: number;
  rule?: string; // set when one of the user's rules changed the advice
}

/** Compares the stop orders resting at IBKR for a holding with the rule's suggestion. */
type HoldingNow = { ticker: string; shares: number; avgCost: number; price: number; atr: number };

/** Compares the stop orders resting at IBKR for a holding with the rule's suggestion, under the user's rules. */
export function adviseStop(h: HoldingNow, sug: StopSuggestion, orders: OpenOrder[], rules: TradingRules = DEFAULT_RULES): StopAdvice {
  if (!rules.neverSellAtLoss || !(h.avgCost > 0)) return chartAdvice(h, sug, orders);
  const cost = ceilCents(h.avgCost); // up: a fill at the stop is never under cost
  const current = orders.filter((o) => o.ticker === h.ticker && o.side === "SELL" && o.stop !== undefined).reduce<number | undefined>((m, o) => (m === undefined || o.stop! > m ? o.stop! : m), undefined);
  const coveredQty = orders.filter((o) => o.ticker === h.ticker && o.side === "SELL" && o.stop !== undefined).reduce((s, o) => s + o.qty, 0);
  const armAt = Math.ceil((h.avgCost + MIN_STOP_ATR * h.atr) * 100) / 100; // price where a stop at cost is 1 ATR away
  const rule = "Never sell at a loss";
  const back = h.price < h.avgCost ? `needs ${pct(h.avgCost / h.price - 1)} to get back to ${usd(h.avgCost)}` : `${pct(h.price / h.avgCost - 1)} over your cost ${usd(h.avgCost)}`;

  if (current !== undefined && current < cost && current < h.price) {
    const fix = h.price >= armAt ? `Raise it to at least your cost: ${usd(Math.max(cost, sug.price))}.` : `Cancel it and hold until the price is above ${usd(armAt)} (cost + 1 ATR), then set a stop at cost.`;
    return {
      verdict: "below-cost",
      headline: `Stop ${usd(current)} would sell at a loss`,
      detail: `It's under your average cost ${usd(h.avgCost)}: a fill loses ${usd(h.shares * (h.avgCost - current))}. ${fix}`,
      current,
      suggested: h.price >= armAt ? Math.max(cost, sug.price) : cost,
      riskAfter: 0,
      coveredQty,
      rule,
    };
  }
  if (h.price < armAt) {
    if (current !== undefined) return { ...chartAdvice(h, { ...sug, price: Math.max(sug.price, cost) }, orders), rule };
    return {
      verdict: "hold",
      headline: h.price < h.avgCost ? `Hold to break-even · ${back}` : `Hold · stop at cost from ${usd(armAt)}`,
      detail:
        h.price < h.avgCost
          ? `Your rule: no stop under cost, so no stop for now. Once the price reaches ${usd(armAt)} (cost + 1 ATR), set a stop at ${usd(cost)}. Until then the downside is open: the chart's stop would be ${usd(sug.price)}.`
          : `Only ${back}, less than 1 ATR (${usd(h.atr)}): a stop at cost would be hit by ordinary noise. Set it at ${usd(cost)} once the price reaches ${usd(armAt)}.`,
      suggested: cost,
      riskAfter: 0,
      coveredQty,
      rule,
    };
  }
  if (sug.price >= cost) return chartAdvice(h, sug, orders);
  const raised: StopSuggestion = { ...sug, price: cost, why: `Your rule never sells under cost, so the chart's ${usd(sug.price)} is lifted to your cost ${usd(cost)}` };
  return { ...chartAdvice(h, raised, orders), rule };
}

function chartAdvice(h: HoldingNow, sug: StopSuggestion, orders: OpenOrder[]): StopAdvice {
  const stops = orders.filter((o) => o.ticker === h.ticker && o.side === "SELL" && o.stop !== undefined).sort((a, b) => b.stop! - a.stop!);
  const coveredQty = stops.reduce((s, o) => s + o.qty, 0);
  const current = stops[0]?.stop;
  const loss = (stop: number) => Math.round(h.shares * (h.price - stop) * 100) / 100;
  const riskAfter = loss(sug.price);
  const base = { suggested: sug.price, riskAfter, coveredQty, current, riskNow: current !== undefined ? loss(current) : undefined };
  const lockNote = (stop: number) => (stop >= h.avgCost ? `it locks in ${usd(h.shares * (stop - h.avgCost))} over your cost` : `that's ${usd(h.shares * (h.avgCost - stop))} under your cost`);
  const sh = (n: number) => `${+n.toFixed(4)} share${n === 1 ? "" : "s"}`;

  if (current === undefined) {
    return {
      ...base,
      verdict: "missing",
      headline: `No stop order · set ${usd(sug.price)}`,
      detail: `Nothing protects ${sh(h.shares)}. At ${usd(sug.price)} (${pct(sug.price / h.price - 1)}) you'd lose ${usd(riskAfter)} from here; ${lockNote(sug.price)}. ${sug.why}.`,
    };
  }
  if (current >= h.price) {
    return { ...base, verdict: "above", headline: `Stop ${usd(current)} is at or above the price`, detail: `A sell stop above the last price ${usd(h.price)} fills at the next trade. Check it in IBKR.` };
  }
  const partial = coveredQty + 1e-6 < h.shares * 0.99;
  const partNote = partial ? ` The stop covers ${+coveredQty.toFixed(4)} of ${sh(h.shares)}.` : "";
  if (sug.price > current + RAISE_MIN_ATR * h.atr) {
    return {
      ...base,
      verdict: "raise",
      headline: `Raise stop ${usd(current)} → ${usd(sug.price)}`,
      detail: `Cuts the loss at the stop from ${usd(base.riskNow!)} to ${usd(riskAfter)}; ${lockNote(sug.price)}. ${sug.why}.${partNote}`,
    };
  }
  if (h.price - current < TIGHT_STOP_ATR * h.atr) {
    return {
      ...base,
      verdict: "tight",
      headline: `Stop ${usd(current)} is within ½ ATR`,
      detail: `Only ${usd(h.price - current)} below the price with a daily range (ATR) of ${usd(h.atr)}: ordinary noise can trigger it. Stops only move up; if you meant it as an exit, keep it.${partNote}`,
    };
  }
  if (partial) {
    return { ...base, verdict: "partial", headline: `Stop covers ${+coveredQty.toFixed(4)} of ${+h.shares.toFixed(4)} shares`, detail: `The stop ${usd(current)} is fine, but part of the position has no stop.` };
  }
  return {
    ...base,
    verdict: "keep",
    headline: `Keep stop ${usd(current)}`,
    detail: `At or above the rule's ${usd(sug.price)} (${sug.basis === "floor" ? "1 ATR floor" : sug.basis === "fallback" ? "2 ATRs" : sug.basis}); stops never move down. Loss at the stop ${usd(base.riskNow!)}; ${lockNote(current)}.`,
  };
}

export type DipVerdict = "discount" | "watch" | "none" | "falling";

export interface DipCheck {
  verdict: DipVerdict;
  headline: string;
  reasons: string[];
  trend: Trend;
  support?: Level;
  /** Where a stop for an add would go: under the support, else 2 ATRs. */
  addStop?: { price: number; why: string };
}

/**
 * Is today's price a discount? In an uptrend (above the 200-day, 50 > 200) count:
 *   at support — within 1 ATR above a strong support
 *   pullback   — RSI ≤ 40, or back at the 50-day average
 *   setup      — an oversold bounce or a reclaimed 20-day average today
 * 2+ = discount, 1 = watch. Mixed trend: watch at most. Downtrend: falling, not a discount.
 */
export function dipCheck(price: number, ind: Indicators, levels: ChartLevels | undefined, setups: SwingSetup[] = [], avgCost?: number): DipCheck {
  const trend = trendOf(price, ind);
  const atr = ind.atr14;
  const reasons: string[] = [];
  const sup = strongSupport(levels, price);
  let hits = 0;
  if (atr && sup && price - sup.price <= AT_SUPPORT_ATR * atr) {
    hits++;
    reasons.push(`At support ${usd(sup.price)} (${sup.touches} touches, ${pct(sup.price / price - 1)})`);
  }
  if (ind.rsi14 !== undefined && ind.rsi14 <= PULLBACK_RSI) {
    hits++;
    reasons.push(`Pulled back: RSI ${ind.rsi14.toFixed(0)}`);
  } else if (ind.sma50 && atr && Math.abs(price - ind.sma50) <= 0.5 * atr) {
    hits++;
    reasons.push(`Back at the 50-day average ${usd(ind.sma50)}`);
  }
  const setupHits = setups.filter((s) => s === "oversold_bounce" || s === "reclaim_ma20");
  if (setupHits.length) {
    hits++;
    reasons.push(setupHits.map((s) => (s === "oversold_bounce" ? "Oversold bounce today" : "Reclaimed the 20-day average")).join(", "));
  }
  if (avgCost && avgCost > 0 && price < avgCost) reasons.push(`${pct(price / avgCost - 1)} below your average cost ${usd(avgCost)}`);
  if (ind.drawdownFromHigh !== undefined && ind.drawdownFromHigh <= -0.1) reasons.push(`${pct(ind.drawdownFromHigh)} from the 52-week high`);

  const addStop = atr
    ? sup && price - sup.price <= 3 * atr
      ? { price: floorCents(sup.price - SUPPORT_BUFFER_ATR * atr), why: `½ ATR under support ${usd(sup.price)}` }
      : { price: floorCents(price - 2 * atr), why: `2 × ATR ${atr.toFixed(2)}` }
    : undefined;

  if (trend === "down") {
    return { verdict: "falling", headline: "Downtrend: lower isn't cheaper", reasons: [`Below the 200-day ${usd(ind.sma200!)} and the 50-day under it`, ...reasons], trend, support: sup, addStop };
  }
  const trendNote = trend === "up" ? "Uptrend (above the 200-day, 50 > 200)" : "Trend mixed (between the averages)";
  if (trend === "up" && hits >= 2) return { verdict: "discount", headline: "Pullback in an uptrend", reasons: [trendNote, ...reasons], trend, support: sup, addStop };
  if (hits >= 1) return { verdict: "watch", headline: trend === "up" ? "One sign of a pullback" : "Pullback, but the trend is mixed", reasons: [trendNote, ...reasons], trend, support: sup, addStop };
  return { verdict: "none", headline: "No discount: not pulled back", reasons: [trendNote, ...reasons], trend, support: sup, addStop };
}

export interface LimitCheck {
  verdict: "fills" | "at-support" | "near" | "far";
  headline: string;
  detail: string;
  dropPct: number; // how far the price must fall to fill (negative)
  atrs?: number;
}

/** A resting BUY limit: how far away it is and whether it sits on a support level. */
export function limitCheck(limit: number, price: number, atr: number | undefined, levels: ChartLevels | undefined, trend: Trend): LimitCheck {
  const drop = limit / price - 1;
  const atrs = atr ? (price - limit) / atr : undefined;
  const downNote = trend === "down" ? " The stock is in a downtrend: a fill here is buying into weakness." : "";
  if (limit >= price) return { verdict: "fills", headline: `At or above the price`, detail: `Limit ${usd(limit)} vs ${usd(price)}: likely fills at the open.${downNote}`, dropPct: drop, atrs };
  const tol = atr ? 0.5 * atr : price * 0.01;
  const near = levels?.supports.find((l) => l.touches >= MIN_TOUCHES && Math.abs(l.price - limit) <= tol);
  const away = `${pct(drop)}${atrs !== undefined ? ` (${atrs.toFixed(1)} ATRs)` : ""} away`;
  if (near) return { verdict: "at-support", headline: `On support ${usd(near.price)}`, detail: `${away}, on a level with ${near.touches} touches: a sensible place to wait.${downNote}`, dropPct: drop, atrs };
  if (atrs !== undefined && atrs <= 1) return { verdict: "near", headline: "Within a day's range", detail: `${away}: one ordinary day can fill it.${downNote}`, dropPct: drop, atrs };
  const sup = levels?.supports.find((l) => l.touches >= MIN_TOUCHES && l.price > limit);
  return {
    verdict: "far",
    headline: atrs !== undefined && atrs > 4 ? "Far below the price" : "Below the price",
    detail: `${away}.${sup ? ` Support ${usd(sup.price)} (${sup.touches} touches) sits above it and may hold first.` : ""}${downNote}`,
    dropPct: drop,
    atrs,
  };
}

/** Earnings inside the next EARNINGS_DAYS trading days (dates as YYYY-MM-DD). */
export function earningsSoon(next: string | undefined, today: string, tradingDays: (from: string, to: string) => number): number | undefined {
  if (!next || next < today) return undefined;
  const n = tradingDays(today, next);
  return n <= EARNINGS_DAYS ? n : undefined;
}

/** Normalizes one row of the gateway's /iserver/account/orders. Returns null for rows that aren't live orders. */
export function parseGatewayOrder(o: Record<string, unknown>): OpenOrder | null {
  const status = String(o.status ?? "");
  if (/cancel|filled|inactive/i.test(status)) return null;
  const ticker = String(o.ticker ?? o.description1 ?? "").trim().toUpperCase();
  const side = String(o.side ?? "").toUpperCase();
  if (!ticker || (side !== "BUY" && side !== "SELL")) return null;
  const n = (v: unknown) => {
    const x = typeof v === "string" ? Number(v.replace(/,/g, "")) : v;
    return typeof x === "number" && Number.isFinite(x) && x > 0 ? x : undefined;
  };
  const type = String(o.orderType ?? o.origOrderType ?? "").toLowerCase();
  const kind: OrderKind = type.includes("trail") ? "trail" : type.includes("stop") && type.includes("limit") ? "stop-limit" : type.includes("stop") ? "stop" : type.includes("limit") ? "limit" : "other";
  const desc = String(o.orderDesc ?? "");
  const descStop = n(/Stop\s+([\d,.]+)/i.exec(desc)?.[1]);
  const stop = kind === "stop" || kind === "stop-limit" || kind === "trail" ? n(o.stop_price) ?? n(o.auxPrice) ?? descStop : undefined;
  const limit = kind === "limit" || kind === "stop-limit" ? n(o.price) : undefined;
  return {
    orderId: String(o.orderId ?? ""),
    ...(n(o.conid) ? { conid: n(o.conid) } : {}),
    ticker,
    side,
    kind,
    stop,
    limit,
    qty: n(o.remainingQuantity) ?? n(o.totalSize) ?? 0,
    tif: String(o.timeInForce ?? ""),
    status,
    desc,
  };
}
