import assert from "node:assert/strict";
import { test } from "node:test";
import { researchDue } from "../lib/data/liveRun";
import type { IntradayBar } from "../lib/setups";
import { hold, netR, runStrategy, STRATEGY_ROSTER, strategyStats, type Trade } from "../lib/strategies";

// Monday 2026-11-23, 9:30 AM New York = 14:30 UTC
const T0 = Date.parse("2026-11-23T14:30:00Z");
const bar = (i: number, open: number, high: number, low: number, close: number, volume = 1000): IntradayBar => ({ t: T0 + i * 5 * 60_000, open, high, low, close, volume });
const flat = (from: number, to: number, px: number) => Array.from({ length: to - from }, (_, k) => bar(from + k, px, px + 0.05, px - 0.05, px));
const S = (id: string) => STRATEGY_ROSTER.find((s) => s.id === id)!;

test("hold: stop first when a bar touches both, 2R target, sold at 3:55", () => {
  const day = [bar(0, 100, 101, 99, 100), bar(1, 100, 106, 97, 100)];
  assert.deepEqual(hold(day, 1, 100, 98), { R: -1, outcome: "stop" });
  assert.deepEqual(hold([bar(0, 100, 104.5, 99.5, 104)], 0, 100, 98), { R: 2, outcome: "target" });
  const close = hold([...flat(0, 77, 101), bar(77, 101, 101, 101, 101)], 0, 100, 98);
  assert.equal(close.outcome, "close");
  assert.equal(close.R, 0.5);
});

test("15-minute breakout: buy-stop at the range high, stop at its low, skips a range too narrow", () => {
  // range 99-102 (2.9%), breaks on bar 4, runs to 2R (108)
  const day = [bar(0, 100, 101, 99, 100.5), bar(1, 100.5, 102, 100, 101.5), bar(2, 101.5, 101.9, 100.8, 101.8), bar(3, 101.8, 101.9, 101, 101.5), bar(4, 101.6, 103, 101.5, 102.8), bar(5, 102.8, 108.5, 102.5, 108), ...flat(6, 78, 108)];
  const t = runStrategy(S("orb15"), day)!;
  assert.equal(t.entry, 102);
  assert.equal(t.stop, 99);
  assert.equal(t.outcome, "target");
  const narrow = day.map((b, i) => (i < 3 ? { ...b, high: 100.5, low: 100 } : b));
  assert.equal(runStrategy(S("orb15"), narrow), null);
});

test("gap and go needs a 2% gap and a green first bar; a retest buys back at the range high", () => {
  const gap = [bar(0, 102.5, 104, 102, 103.8), bar(1, 103.8, 104.5, 103.5, 104.3), ...flat(2, 78, 104.3)];
  assert.equal(runStrategy(S("gap-go"), gap, 100)!.entry, 104);
  assert.equal(runStrategy(S("gap-go"), gap, 101.5), null); // under 2%
  const retest = [bar(0, 100, 101, 99, 100.5), bar(1, 100.5, 102, 100, 101.5), bar(2, 101.5, 101.9, 100.8, 101.8), bar(3, 101.8, 103, 101.7, 102.6), bar(4, 102.6, 102.7, 101.8, 102.2), ...flat(5, 78, 102.2)];
  const t = runStrategy(S("orb-retest"), retest)!;
  assert.equal(t.entry, 102);
  assert.equal(t.stop, 99);
});

test("stats: an edge needs the whole 95% range above zero and a profit after fees at the budget", () => {
  // half the trades hit 2R, half lose 1R: +0.5R a trade before fees
  const win = (k: number): Trade => ({ strategy: "x", entryAt: T0 + k, entry: 50, stop: 49, R: k % 2 ? -1 : 2, outcome: k % 2 ? "stop" : "target" });
  const trades = Array.from({ length: 60 }, (_, k) => win(k));
  assert.equal(strategyStats(S("orb15"), trades, 5000).verdict, "edge");
  // the same trades at $200: 3 shares risk $3, and about $2 of fees takes the +0.5R under zero
  const small = strategyStats(S("orb15"), trades, 200);
  assert.equal(small.verdict, "maybe");
  assert.match(small.why, /fees take it under zero/);
  assert.equal(strategyStats(S("orb15"), trades.slice(0, 10), 5000).verdict, "too few");
  assert.ok(netR(win(0), 5000)! > 1.9); // a 2R winner at $5k: fees barely dent it
});

test("research runs Saturdays from 10 AM New York (or Sunday), at most every 4 days", () => {
  assert.equal(researchDue(new Date("2026-11-28T16:00:00Z")), true); // Sat 11 AM NY, never ran
  assert.equal(researchDue(new Date("2026-11-28T14:00:00Z")), false); // Sat 9 AM
  assert.equal(researchDue(new Date("2026-11-27T16:00:00Z")), false); // Friday
  assert.equal(researchDue(new Date("2026-11-29T16:00:00Z"), "2026-11-28T16:30:00Z"), false); // ran yesterday
  assert.equal(researchDue(new Date("2026-11-29T16:00:00Z"), "2026-11-21T16:30:00Z"), true); // last week's
});
