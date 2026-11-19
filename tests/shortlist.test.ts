import assert from "node:assert/strict";
import { test } from "node:test";
import { countReasons, isPick, rankShortlist, screenDaily, type ShortlistPick } from "../lib/shortlist";

// 60 sessions: a steady climb with a 2% zig-zag, so it moves enough and trends up
const climb = (start: number, step: number) => Array.from({ length: 60 }, (_, i) => (start + i * step) * (i % 2 ? 1.02 : 0.98));
const o = { maxPrice: 150, spyReturn20: -5 };

test("shortlist: a liquid daily uptrend that beats SPY is kept, with its numbers", () => {
  const r = screenDaily("UP", climb(40, 0.3), 1_000_000, o);
  assert.ok(isPick(r));
  if (isPick(r)) {
    assert.ok(r.price > r.sma20 && r.sma20 > r.sma50);
    assert.ok(r.avgMovePct >= 1.2 && (r.rs20 ?? 0) > 0 && r.dollarVolume >= 10_000_000);
  }
});

test("shortlist: every rule drops with a plain reason", () => {
  const why = (closes: number[], vol: number, opts = o) => {
    const r = screenDaily("X", closes, vol, opts);
    return isPick(r) ? "kept" : r.why;
  };
  assert.equal(why(climb(40, 0.3).slice(0, 49), 1e6), "under 50 sessions of history");
  assert.equal(why(climb(2, 0.01), 1e8), "price under $5");
  assert.equal(why(climb(200, 1), 1e6), "one share costs more than the account allows");
  assert.equal(why(climb(40, 0.3), 1000), "thin: under $10M traded a day");
  assert.match(why(climb(80, -0.3), 1e6), /no daily uptrend/);
  const spike = [...climb(40, 0.3).slice(0, 59), 80];
  assert.match(why(spike, 1e6), /stretched/);
  const quiet = Array.from({ length: 60 }, (_, i) => 40 + i * 0.1);
  assert.match(why(quiet, 1e6), /too quiet/);
  assert.equal(why(climb(40, 0.3), 1e6, { maxPrice: 150, spyReturn20: 50 }), "weaker than SPY over 20 days");
  const all = ["A", "B"].map((s) => screenDaily(s, climb(80, -0.3), 1e6, o));
  assert.deepEqual(Object.values(countReasons(all)), [2]);
});

test("shortlist: ranked by strength against SPY, then dollar volume", () => {
  const p = (symbol: string, rs20: number, dollarVolume: number) => ({ symbol, rs20, dollarVolume, ret20: rs20 }) as ShortlistPick;
  assert.deepEqual(rankShortlist([p("A", 5, 1), p("B", 9, 1), p("C", 5, 3)]).map((x) => x.symbol), ["B", "C", "A"]);
});
