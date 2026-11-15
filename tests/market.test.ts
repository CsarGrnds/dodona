import assert from "node:assert/strict";
import { test } from "node:test";
import { filterRecords, swingBacktest, type TradeResult } from "../lib/backtest";
import { computeIndicators } from "../lib/indicators";
import { marketAt, marketBefore, marketSeries, passes, relativeStrength, volumeRatio } from "../lib/market";
import { swingSignal } from "../lib/signals";
import type { Bar } from "../lib/types";

const DAY = 86_400_000;
function bars(closes: number[], vol: (i: number) => number = () => 1e6): Bar[] {
  return closes.map((c, i) => ({ time: new Date(Date.UTC(2024, 0, 1) + i * DAY).toISOString().slice(0, 10), open: c, high: c * 1.01, low: c * 0.99, close: c, volume: vol(i) }));
}
const up = (n: number, g = 1.002) => Array.from({ length: n }, (_, i) => 100 * Math.pow(g, i));

test("market context: up, down and mixed trends with explainable detail", () => {
  const u = marketAt(marketSeries(bars(up(260))))!;
  assert.equal(u.trend, "up");
  assert.ok(u.above50 && u.above200);
  assert.match(u.detail, /SPY .* vs 50d .*200d/);
  const d = marketAt(marketSeries(bars(up(260, 0.998))))!;
  assert.equal(d.trend, "down");
  // long rally then a sharp month down: below the 50-day, still above the 200-day
  const mixed = marketAt(marketSeries(bars([...up(230, 1.003), ...Array.from({ length: 30 }, (_, i) => 198 - i)])))!;
  assert.equal(mixed.trend, "mixed", mixed.detail);
  assert.ok(!mixed.above50 && mixed.above200);
});

test("intraday market check uses the previous close (no look-ahead)", () => {
  const b = bars(up(260));
  const ms = marketSeries(b);
  const today = b[259].time;
  assert.equal(marketBefore(ms, today)!.date, b[258].time);
  assert.equal(marketAt(ms, today)!.date, today);
  // a weekend/holiday date falls back to the last bar before it
  const after = new Date(Date.parse(today) + 3 * DAY).toISOString().slice(0, 10);
  assert.equal(marketBefore(ms, after)!.date, today);
});

test("relative strength and volume ratio", () => {
  const spy = bars(up(100, 1.001));
  const stock = bars(up(100, 1.003));
  const rs = relativeStrength(stock, 99, marketSeries(spy))!;
  assert.ok(rs > 0.1, `rs ${rs}`);
  assert.equal(relativeStrength(stock, 10, marketSeries(spy)), undefined, "needs 63 days");
  const v = bars(up(30), (i) => (i === 29 ? 3e6 : 1e6));
  assert.equal(volumeRatio(v, 29), 3);
  assert.equal(volumeRatio(v, 5), undefined);
});

test("filters: each check and 'all'", () => {
  const ctx = { marketUp: true, rs: 0.05, volX: 1.2 };
  assert.ok(passes(ctx, "market", 1.5));
  assert.ok(passes(ctx, "rs", 1.5));
  assert.ok(!passes(ctx, "volume", 1.5));
  assert.ok(passes(ctx, "volume", 1.0));
  assert.ok(!passes(ctx, "all", 1.5));
  assert.ok(passes(ctx, "all", 1.0));
  assert.ok(!passes(undefined, "market", 1));
});

test("filterRecords splits the same trades by filter", () => {
  const t = (R: number, ctx: TradeResult["ctx"]): TradeResult => ({ date: "d", entry: 10, stop: 9, target: 12, outcome: R > 0 ? "target" : "stop", exit: 0, R, days: 1, ctx });
  const f = filterRecords([t(2, { marketUp: true, rs: 0.1, volX: 2 }), t(-1, { marketUp: false, rs: 0.1, volX: 2 }), t(-1, { marketUp: true, rs: -0.1, volX: 1 })], 1.5);
  assert.equal(f.market.trades, 2);
  assert.equal(f.rs.trades, 2);
  assert.equal(f.volume.trades, 2);
  assert.equal(f.all.trades, 1);
  assert.equal(f.all.avgR, 2);
});

test("swing backtest attaches context and filtered records when market data is given", () => {
  const stock = bars(up(300, 1.004), (i) => (i % 7 === 0 ? 3e6 : 1e6));
  const spy = bars(up(300, 1.001));
  const bt = swingBacktest(stock, undefined, marketSeries(spy));
  assert.ok(bt.filtered);
  const all = bt.bySetup.breakout_20d.trades;
  const mkt = bt.filtered!.breakout_20d.market.trades;
  assert.ok(all > 0 && mkt <= all);
  assert.equal(swingBacktest(stock).filtered, undefined, "no market data → no filtered records");
});

test("swing rules: market and relative-strength factors are explainable and bounded", () => {
  const b = bars(up(260));
  const ind = computeIndicators(b);
  const ms = marketSeries(bars(up(260, 0.998)));
  const sig = swingSignal(b[259].close, ind, { market: marketAt(ms), relativeStrength: 0.15 });
  const m = sig.factors.find((f) => f.name === "Market (SPY)")!;
  const r = sig.factors.find((f) => f.name === "Relative strength")!;
  assert.equal(m.score, -2);
  assert.match(m.detail, /Downtrend/);
  assert.equal(r.score, 2);
  for (const f of sig.factors) assert.ok(f.score >= -2 && f.score <= 2);
  assert.ok(!swingSignal(b[259].close, ind).factors.some((f) => f.name.startsWith("Market")), "skipped without market data");
});
