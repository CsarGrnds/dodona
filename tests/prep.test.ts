import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChartLevels, Level } from "../lib/levels";
import { adviseStop, dipCheck, earningsSoon, limitCheck, parseGatewayOrder, suggestStop, trendOf, type OpenOrder } from "../lib/prep";
import { tradingDaysBetween } from "../lib/clock";
import type { Bar, Indicators } from "../lib/types";

const DAY = 86_400_000;
const bar = (i: number, c: number, h = c + 1, l = c - 1): Bar => ({ time: new Date(Date.UTC(2026, 0, 1) + i * DAY).toISOString().slice(0, 10), open: c, high: h, low: l, close: c, volume: 1e6 });
const lvl = (price: number, touches: number, kind: Level["kind"] = "support"): Level => ({ price, touches, kind, lastDate: "2026-06-01", distancePct: 0 });
const levels = (supports: Level[], resistances: Level[] = []): ChartLevels => ({ supports, resistances, lookbackDays: 250 });
const up: Indicators = { sma20: 98, sma50: 95, sma200: 85, rsi14: 55, atr14: 2 };

test("suggested stop: the highest of trail, support and break-even, never within 1 ATR", () => {
  const bars = Array.from({ length: 30 }, (_, i) => bar(i, 100)); // highs 101
  // trail = 101 − 3×2 = 95; support 96 − 1 = 95.00 → tie, trail first
  let s = suggestStop(bars, 100, up, levels([lvl(96, 3)]))!;
  assert.equal(s.price, 95);
  assert.equal(s.basis, "trail");
  // a higher strong support wins; a 1-touch one is ignored
  s = suggestStop(bars, 100, up, levels([lvl(98.6, 1), lvl(97.5, 2)]))!;
  assert.equal(s.basis, "support");
  assert.equal(s.price, 96.5);
  // break-even once 3 ATRs up (cost 93 → 7 / 2 = 3.5 ATRs): 93 < 95 trail, so trail stays
  s = suggestStop(bars, 100, up, undefined, 93)!;
  assert.equal(s.price, 95);
  assert.ok(s.candidates.some((c) => c.key === "breakeven"));
  // extended (RSI 80) → 2 ATR trail = 97; a support right under the price is capped at price − 1 ATR
  s = suggestStop(bars, 100, { ...up, rsi14: 80 }, levels([lvl(99.6, 2)]))!;
  assert.ok(s.extended);
  assert.equal(s.basis, "trail");
  assert.equal(s.price, 97);
  s = suggestStop(bars, 100, { ...up, atr14: 0.5, sma20: 99.5 }, undefined, 10)!; // trail 101 − 1.5 = 99.5 = the 1-ATR cap: kept
  assert.equal(s.price, 99.5);
  assert.equal(suggestStop(bars.slice(0, 10), 100, up), null, "needs 22 sessions");
  assert.match(adviseStop({ ticker: "XYZ", shares: 1, avgCost: 120, price: 100, atr: 2 }, s, [], { neverSellAtLoss: false }).detail, /Nothing protects 1 share\. .*that's \$20\.50 under your cost/);
});

test("a stock already past its trailing stop falls back on support, else 2 ATRs", () => {
  const fell = [...Array.from({ length: 25 }, (_, i) => bar(i, 120)), bar(25, 100)]; // 22-day high 121, now 100
  let s = suggestStop(fell, 100, { ...up, rsi14: 30 })!;
  assert.ok(s.trailBroken);
  assert.equal(s.basis, "fallback");
  assert.equal(s.price, 96);
  assert.match(s.why, /Down 10\.5 ATRs from its 22-day high/);
  s = suggestStop(fell, 100, { ...up, rsi14: 30 }, levels([lvl(98, 2)]))!;
  assert.equal(s.basis, "support");
  assert.equal(s.price, 97);
});

const order = (o: Partial<OpenOrder>): OpenOrder => ({ orderId: "1", ticker: "XYZ", side: "SELL", kind: "stop", qty: 10, tif: "GTC", status: "PreSubmitted", desc: "", ...o });
const h = { ticker: "XYZ", shares: 10, avgCost: 80, price: 100, atr: 2 };
const sug = { price: 95, basis: "trail" as const, candidates: [], extended: false, trailBroken: false, why: "22-day high − 3 × ATR" };

test("stop advice: raise, keep, tight, missing, partial — stops only move up", () => {
  const raise = adviseStop(h, sug, [order({ stop: 90 })]);
  assert.equal(raise.verdict, "raise");
  assert.equal(raise.riskNow, 100);
  assert.equal(raise.riskAfter, 50);
  assert.match(raise.detail, /locks in \$150\.00/);
  assert.equal(adviseStop(h, sug, [order({ stop: 94.8 })]).verdict, "keep", "a raise under ¼ ATR isn't worth it");
  assert.equal(adviseStop(h, sug, [order({ stop: 97 })]).verdict, "keep", "higher than the rule: never lowered");
  assert.equal(adviseStop(h, sug, [order({ stop: 99.5 })]).verdict, "tight");
  assert.equal(adviseStop(h, sug, [order({ stop: 101 })]).verdict, "above");
  assert.equal(adviseStop(h, sug, [order({ stop: 96, qty: 4 })]).verdict, "partial");
  const none = adviseStop(h, sug, [order({ side: "BUY", kind: "limit", limit: 90, stop: undefined }), order({ ticker: "ABC", stop: 50 })]);
  assert.equal(none.verdict, "missing");
  assert.equal(none.riskAfter, 50);
});

test("dip check: discount only in an uptrend; a downtrend is falling", () => {
  assert.equal(trendOf(100, up), "up");
  const sup = levels([lvl(98.5, 3)]);
  const d = dipCheck(100, { ...up, rsi14: 38 }, sup);
  assert.equal(d.verdict, "discount");
  assert.equal(d.addStop?.price, 97.5);
  assert.equal(dipCheck(100, up, sup).verdict, "watch", "support alone is one sign");
  assert.equal(dipCheck(100, { ...up, rsi14: 60 }, levels([])).verdict, "none");
  const down = dipCheck(70, { ...up, sma50: 80, rsi14: 25 }, sup);
  assert.equal(down.verdict, "falling");
  assert.equal(dipCheck(100, { ...up, sma50: 99.5, rsi14: 50 }, levels([]), ["oversold_bounce"]).verdict, "discount", "50-day + bounce");
  assert.equal(dipCheck(88, { ...up, sma50: 84, rsi14: 35 }, levels([lvl(87, 2)])).verdict, "watch", "mixed trend caps at watch");
});

test("buy limits: fills, on support, near, far", () => {
  const sup = levels([lvl(92, 3), lvl(85, 2)]);
  assert.equal(limitCheck(101, 100, 2, sup, "up").verdict, "fills");
  assert.equal(limitCheck(92.5, 100, 2, sup, "up").verdict, "at-support");
  assert.equal(limitCheck(98.5, 100, 2, sup, "up").verdict, "near");
  const far = limitCheck(80, 100, 2, sup, "down");
  assert.equal(far.verdict, "far");
  assert.match(far.detail, /Support \$92\.00/);
  assert.match(far.detail, /downtrend/);
});

test("gateway orders are normalized; earnings within 7 trading days", () => {
  const stop = parseGatewayOrder({ orderId: 1, ticker: "XYZ", side: "SELL", orderType: "Stop", auxPrice: "89.38", stop_price: "89.38", price: "", remainingQuantity: 5.2842, timeInForce: "GTC", status: "PreSubmitted", orderDesc: "Sell 5.2842 XYZ Stop 89.38, GTC" })!;
  assert.deepEqual([stop.kind, stop.stop, stop.limit, stop.qty], ["stop", 89.38, undefined, 5.2842]);
  const lim = parseGatewayOrder({ orderId: 2, ticker: "ABC", side: "BUY", orderType: "Limit", price: "46.00", remainingQuantity: 2, status: "Submitted" })!;
  assert.deepEqual([lim.kind, lim.limit, lim.stop], ["limit", 46, undefined]);
  assert.equal(parseGatewayOrder({ ticker: "ABC", side: "BUY", orderType: "Limit", price: "1", status: "Cancelled" }), null);
  assert.equal(earningsSoon("2026-11-19", "2026-11-15", tradingDaysBetween), 4);
  assert.equal(earningsSoon("2026-12-15", "2026-11-15", tradingDaysBetween), undefined);
});

test("never sell at a loss: hold under water, flag a stop under cost, lift stops to cost", () => {
  const sugLow = { price: 95, basis: "trail" as const, candidates: [], extended: false, trailBroken: false, why: "chart" };
  // under water: hold, no stop (IBM-like)
  const under = adviseStop({ ticker: "XYZ", shares: 10, avgCost: 120, price: 100, atr: 2 }, sugLow, []);
  assert.equal(under.verdict, "hold");
  assert.match(under.headline, /needs \+20\.0% to get back to \$120\.00/);
  assert.match(under.detail, /reaches \$122\.00/);
  // a stop under cost is flagged
  const bad = adviseStop({ ticker: "XYZ", shares: 10, avgCost: 120, price: 100, atr: 2 }, sugLow, [order({ stop: 90 })]);
  assert.equal(bad.verdict, "below-cost");
  assert.match(bad.detail, /a fill loses \$300\.00/);
  assert.match(bad.detail, /Cancel it/);
  // in profit by under 1 ATR: hold, stop at cost later
  assert.equal(adviseStop({ ticker: "XYZ", shares: 10, avgCost: 99, price: 100, atr: 2 }, sugLow, []).verdict, "hold");
  // 1+ ATR above cost: the chart stop is lifted to the cost
  const lift = adviseStop({ ticker: "XYZ", shares: 10, avgCost: 97, price: 100, atr: 2 }, sugLow, []);
  assert.equal(lift.verdict, "missing");
  assert.equal(lift.suggested, 97);
  assert.equal(lift.rule, "Never sell at a loss");
  // chart stop already over cost: rule changes nothing
  const fine = adviseStop(h, sug, [order({ stop: 90 })]);
  assert.equal(fine.verdict, "raise");
  assert.equal(fine.rule, undefined);
  // rule off: the chart's stop under cost is suggested
  assert.equal(adviseStop({ ticker: "XYZ", shares: 10, avgCost: 120, price: 100, atr: 2 }, sugLow, [], { neverSellAtLoss: false }).verdict, "missing");
});
