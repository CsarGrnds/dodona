import assert from "node:assert/strict";
import { test } from "node:test";
import { learningStats, replay, type Candidate } from "../lib/learning";
import { chartFacts, chartSvg, sessions } from "../lib/chart";

// 5-minute bars on 2026-11-18 (New York is UTC-5): 09:30 = 14:30Z
const t = (hhmm: string) => Date.parse(`2026-11-18T${String(Number(hhmm.slice(0, 2)) + 5).padStart(2, "0")}:${hhmm.slice(3)}:00Z`);
const bar = (hhmm: string, open: number, high: number, low: number, close: number) => ({ t: t(hhmm), open, high, low, close, volume: 1000 });
const C: Candidate = { at: "2026-11-18T14:50:00Z", date: "2026-11-18", mode: "live", symbol: "X", setup: "orb", trigger: 10, stop: 9.5, target: 11, verdict: "take", why: "t" };

test("replay: target first, stop first, the close, never triggered", () => {
  const before = [bar("09:30", 9.8, 9.9, 9.7, 9.85), bar("09:45", 9.85, 9.95, 9.8, 9.9)];
  const win = replay(C, [...before, bar("09:50", 9.9, 10.1, 9.9, 10.05), bar("09:55", 10.05, 10.6, 10, 10.5), bar("10:00", 10.5, 11.2, 10.4, 11)]);
  assert.deepEqual([win.outcome, win.R, win.triggeredAt, win.exitAt, win.rightCall], ["target", 2, "09:50", "10:00", true]);
  const loss = replay(C, [...before, bar("09:50", 9.9, 10.1, 9.9, 10), bar("09:55", 10, 10.05, 9.4, 9.5)]);
  assert.deepEqual([loss.outcome, loss.R, loss.rightCall], ["stop", -1, false]);
  const skipLoss = replay({ ...C, verdict: "skip" }, [...before, bar("09:50", 9.9, 10.1, 9.9, 10), bar("09:55", 10, 10.05, 9.4, 9.5)]);
  assert.equal(skipLoss.rightCall, true, "skipping a loser is a right call");
  const flat = replay(C, [...before, bar("09:50", 9.9, 10.1, 9.95, 10.05), bar("15:55", 10.2, 10.3, 10.1, 10.25)]);
  assert.deepEqual([flat.outcome, flat.R], ["close", 0.4]);
  const none = replay(C, [...before, bar("09:50", 9.9, 9.95, 9.8, 9.9)]);
  assert.deepEqual([none.outcome, none.R, none.rightCall], ["not-triggered", 0, null]);
  assert.equal(replay({ ...C, verdict: "skip" }, [...before, bar("09:50", 9.9, 9.95, 9.8, 9.9)]).rightCall, true);
  // a bar before the decision doesn't count
  const early = replay(C, [bar("09:30", 9.8, 10.2, 9.7, 10.1), bar("09:50", 10.1, 10.15, 9.4, 9.5)]);
  assert.equal(early.triggeredAt, "09:50");
  // a gap above the trigger fills at the open
  const gap = replay(C, [...before, bar("09:50", 10.2, 10.3, 10.1, 10.25), bar("09:55", 10.25, 11.1, 10.2, 11)]);
  assert.equal(gap.R, Math.round(((11 - 10.2) / 0.5) * 100) / 100);
});

test("learning stats: what works, by verdict, setup and chart score", () => {
  const r = (verdict: "take" | "skip", R: number, chartScore?: number) => ({ ...C, verdict, chartScore, outcome: R ? (R > 0 ? "target" : "stop") : "not-triggered", R, rightCall: verdict === "take" ? R > 0 : R <= 0 }) as const;
  const s = learningStats([r("take", 2, 5), r("take", -1, 2), r("skip", -1, 2), r("skip", 0)]);
  assert.deepEqual(s.byVerdict.take, { n: 2, triggered: 2, avgR: 0.5, winRate: 0.5, rightCalls: 1 });
  assert.equal(s.byChartScore["4-5"].avgR, 2);
  assert.equal(s.byChartScore["1-2"].avgR, -1);
  assert.match(s.sampleNote ?? "", /Only 4 candidates/);
});

test("chart: sessions, facts and an SVG with the plan's lines", () => {
  const intraday = [bar("09:30", 10, 10.4, 9.9, 10.3), bar("09:35", 10.3, 10.5, 10.2, 10.4), bar("09:40", 10.4, 10.45, 10.1, 10.2), bar("09:45", 10.2, 10.6, 10.2, 10.55)];
  const daily = Array.from({ length: 70 }, (_, i) => ({ time: `2026-08-${String((i % 28) + 1).padStart(2, "0")}`, open: 9, high: 9.5 + (i === 30 ? 3 : 0), low: 8.5, close: 9.2, volume: 1e6 }));
  assert.equal(sessions(intraday).length, 1);
  const f = chartFacts(daily, intraday, { trigger: 10.5, stop: 10, target: 11.5 });
  assert.deepEqual(f.openingRange, { high: 10.5, low: 9.9 });
  assert.equal(f.high60d, 12.5);
  assert.equal(f.roomToResistance?.label, "60-day high");
  const svg = chartSvg("X", daily, intraday, { trigger: 10.5, stop: 10, target: 11.5 });
  assert.match(svg, /^<svg/);
  assert.match(svg, /trigger 10\.50/);
  assert.match(svg, /OR high/);
});

test("chart: ATR, the stop in ATRs, strength vs SPY, earnings and filings", async () => {
  const { atr, filingEvents } = await import("../lib/chart");
  const day = (i: number) => new Date(Date.UTC(2026, 6, 1) + i * 86_400_000).toISOString().slice(0, 10);
  // 70 days, the stock rising 1% a day for the last 20, SPY flat; each bar 1.00 high-low
  const daily = Array.from({ length: 70 }, (_, i) => {
    const c = i < 50 ? 10 : 10 * 1.01 ** (i - 49);
    return { time: day(i), open: c, high: c + 0.5, low: c - 0.5, close: c, volume: 1e6 };
  });
  const spy = daily.map((b) => ({ ...b, open: 500, high: 501, low: 499, close: 500 }));
  assert.equal(atr(daily.slice(0, 40)), 1); // flat closes: the true range is the bar's range
  const filings = filingEvents([
    { form: "8-K", filed: day(60), items: ["2.02", "9.01"], labels: ["Results of operations"] },
    { form: "10-Q", filed: day(61), items: [], labels: [] },
    { form: "8-K", filed: day(5), items: ["5.02"], labels: ["Officer change"] }, // before the 60-session window
  ]);
  assert.deepEqual(filings.map((e) => e.kind), ["earnings", "10-Q", "8-K"]);
  const ctx = { spy, nextEarnings: day(80), earningsEstimated: true, events: filings, tradingDays: () => 7 };
  const f = chartFacts(daily, [], { trigger: 12.3, stop: 11.8 }, ctx);
  assert.equal(f.atr14, 1); // each day's 1.00 range covers the 1% gaps
  assert.equal(f.stopInAtr, 0.5); // (12.30 − 11.80) / 1.00
  assert.ok(f.vsSpy && f.vsSpy.spy20d === 0 && f.vsSpy.diff === f.vsSpy.stock20d && f.vsSpy.stock20d > 20);
  assert.deepEqual(f.nextEarnings, { date: day(80), tradingDays: 7, estimated: true });
  assert.deepEqual(f.events?.map((e) => e.date), [day(61), day(60)]); // in the window, newest first
  const svg = chartSvg("X", daily, [], { trigger: 12.3, stop: 11.8 }, ctx);
  assert.match(svg, /EARNINGS/);
  assert.match(svg, /SPY \(scaled\)/);
  assert.match(svg, /vs SPY \+0\.0%/);
  // nothing from outside: no SPY, no events, no earnings
  const bare = chartFacts(daily, [], {});
  assert.equal(bare.vsSpy, undefined);
  assert.equal(bare.stopInAtr, undefined);
  assert.deepEqual(bare.events, []);
});

test("pending: a formed range still under its high, above VWAP; broken or weak ones say why", async () => {
  const { pendingRange, isPending } = await import("../lib/pending");
  const now = Date.parse("2026-11-18T15:05:00Z"); // 10:05 New York: 6 completed bars
  const base = [bar("09:30", 10, 10.2, 9.9, 10.1), bar("09:35", 10.1, 10.3, 10.05, 10.2), bar("09:40", 10.2, 10.25, 10.1, 10.15)];
  const ok = pendingRange("X", [...base, bar("09:45", 10.15, 10.28, 10.12, 10.22), bar("09:50", 10.22, 10.29, 10.2, 10.27), bar("09:55", 10.27, 10.3, 10.22, 10.26)], { nowMs: now });
  assert.ok(isPending(ok));
  if (isPending(ok)) assert.deepEqual([ok.orHigh, ok.orLow, ok.bars], [10.3, 9.9, 6]);
  const broke = pendingRange("X", [...base, bar("09:45", 10.2, 10.4, 10.2, 10.35)], { nowMs: now });
  assert.equal("why" in broke && broke.why, "already broke out");
  const far = pendingRange("X", [...base, bar("09:45", 10.1, 10.1, 9.95, 9.96)], { nowMs: now });
  assert.ok("why" in far);
  const early = pendingRange("X", base.slice(0, 2), { nowMs: Date.parse("2026-11-18T14:40:00Z") });
  assert.equal("why" in early && early.why, "the opening range hasn't formed yet");
});

test("pending: a stock under both its 20- and 50-day averages is a daily downtrend", async () => {
  const { dailyTrend } = await import("../lib/pending");
  const day = (i: number, close: number) => ({ time: `2026-0${1 + Math.floor(i / 28)}-${String(1 + (i % 28)).padStart(2, "0")}`, open: close, high: close, low: close, close, volume: 1 });
  const falling = Array.from({ length: 60 }, (_, i) => day(i, 100 - i)); // 100 → 41
  const down = dailyTrend(falling, "2026-11-19", 40);
  assert.ok(down && "why" in down && down.why.startsWith("daily downtrend"));
  const up = dailyTrend(falling.map((b, i) => ({ ...b, close: 41 + i })), "2026-11-19", 102);
  assert.ok(up && "sma20" in up && up.sma20 > up.sma50);
  // above the 50-day but under the 20-day: a pullback, not a downtrend (the chartist judges it)
  const pull = dailyTrend(falling.map((b, i) => ({ ...b, close: i < 50 ? 41 + i : 95 })), "2026-11-19", 90);
  assert.ok(pull && "sma20" in pull);
  // today's own bar is never part of the averages, and too little history gives no verdict
  assert.equal(dailyTrend(falling.slice(0, 49), "2026-11-19", 1), null);
  assert.equal(dailyTrend(falling, "2026-01-01", 1), null);
});
