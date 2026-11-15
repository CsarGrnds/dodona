import assert from "node:assert/strict";
import { test } from "node:test";
import { orbBacktest, summarize, swingBacktest } from "../lib/backtest";
import { buildTradePlan, DEFAULT_PLAN_SETTINGS } from "../lib/plan";
import { clockLabel, findSwingSetups, nyClock, orbHit, orMidStop, splitSessions, type IntradayBar } from "../lib/setups";
import type { Bar } from "../lib/types";

const flat = (n: number, v = 100) => Array.from({ length: n }, (_, i) => v + Math.sin(i) * 0.5);

test("20-day breakout: last close above the prior 20 closes' high", () => {
  const c = [...flat(40), 105];
  assert.ok(findSwingSetups(c)!.tags.includes("breakout_20d"));
  assert.ok(!findSwingSetups([...flat(40), 100])!.tags.includes("breakout_20d"));
});

test("bull flag: >10% run from 15 to 5 days ago, then a tight 5-day range", () => {
  const base = flat(25, 100);
  const run = Array.from({ length: 10 }, (_, i) => 100 + (i + 1) * 1.6); // 101.6 .. 116
  const flag = [116, 116.5, 115.8, 116.2, 116.1];
  const tags = findSwingSetups([...base, ...run, ...flag])!.tags;
  assert.ok(tags.includes("bull_flag"), `tags ${tags}`);
});

test("reclaim the 20-day average and oversold / oversold bounce", () => {
  const down = Array.from({ length: 30 }, (_, i) => 100 - i * 0.2);
  const reclaim = [...down, 103];
  assert.ok(findSwingSetups(reclaim)!.tags.includes("reclaim_ma20"));

  const crash = Array.from({ length: 40 }, (_, i) => 100 - i * 1.5);
  const s1 = findSwingSetups(crash)!;
  assert.ok(s1.tags.includes("oversold"), `rsi ${s1.numbers.rsi}`);
  const bounce = findSwingSetups([...crash, crash.at(-1)! + 0.5])!;
  assert.ok(bounce.tags.includes("oversold_bounce"));
  assert.equal(findSwingSetups(flat(10)), null, "needs 30 closes");
});

// ---------- intraday helpers: build NY-time sessions without hardcoding DST
function nyOpen(dateUtcMidnight: number) {
  return [13.5, 14.5].map((h) => dateUtcMidnight + h * 3_600_000).find((t) => nyClock(t).minute === 570)!;
}
function session(dayUtc: number, closes: number[], hiLo = 0.1): IntradayBar[] {
  const open = nyOpen(dayUtc);
  return closes.map((c, k) => ({ t: open + k * 300_000, open: k ? closes[k - 1] : c, high: c + hiLo, low: c - hiLo, close: c, volume: 1000 }));
}
const DAY = 86_400_000;
const MON = Date.UTC(2026, 9, 19); // Monday 19 Oct 2026 (EDT)
const MON_WINTER = Date.UTC(2026, 10, 9); // Monday 9 Nov 2026 (EST)

test("nyClock handles daylight saving", () => {
  assert.equal(nyClock(nyOpen(MON)).minute, 570);
  assert.equal(nyClock(nyOpen(MON)).date, "2026-10-19");
  assert.equal(nyClock(nyOpen(MON_WINTER)).minute, 570);
  assert.equal(clockLabel(10 * 60 + 15), "10:15 AM");
  assert.equal(clockLabel(15 * 60 + 55), "3:55 PM");
});

test("ORB: first CLOSE above the opening-range high; stop at the midpoint", () => {
  // range bars 100, 101, 100.5 (high 101.1, low 99.9); bar 5 closes 101.3 > 101.1
  const closes = [100, 101, 100.5, 100.8, 101.0, 101.3, 101.5, ...Array(71).fill(101.6)];
  const bars = session(MON, closes);
  const hit = orbHit(bars)!;
  assert.equal(hit.barIndex, 5);
  assert.equal(hit.price, 101.3);
  assert.equal(hit.orHigh, 101.1);
  assert.equal(hit.atMinute, 570 + 30);
  assert.equal(orMidStop(hit.orHigh, hit.orLow), 100.5);
});

test("splitSessions keeps full 78-bar sessions and drops pre-market and forming bars", () => {
  const s1 = session(MON, Array(78).fill(100));
  const pre: IntradayBar = { ...s1[0], t: s1[0].t - 30 * 60_000 };
  const s2 = session(MON + DAY, Array(10).fill(100));
  const sessions = splitSessions([pre, ...s1, ...s2], s2[9].t + 60_000); // bar 9 still forming
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].full, true);
  assert.equal(sessions[0].bars.length, 78);
  assert.equal(sessions[1].bars.length, 9);
  assert.equal(sessions[1].full, false);
});

test("ORB track record: target, stop (both-in-one-bar = stop) and flat at the close", () => {
  const up = session(MON, [100, 101, 100.5, 101.3, ...Array.from({ length: 74 }, (_, i) => 101.4 + i * 0.05)]);
  // entry 101.3, stop 100.5 (risk 0.8), target 102.9 → hit on the way up
  const down = session(MON + DAY, [100, 101, 100.5, 101.3, ...Array(74).fill(100.2)]);
  const both = session(MON + 2 * DAY, [100, 101, 100.5, 101.3, 101.4, ...Array(73).fill(101.4)]).map((b, k) => (k === 4 ? { ...b, high: 110, low: 90 } : b));
  const drift = session(MON + 3 * DAY, [100, 101, 100.5, 101.3, ...Array(74).fill(101.7)]);
  const none = session(MON + 4 * DAY, Array(78).fill(100));
  const bt = orbBacktest(splitSessions([...up, ...down, ...both, ...drift, ...none], MON + 10 * DAY));
  assert.equal(bt.sessions, 5);
  assert.equal(bt.record.trades, 4, "no breakout on the flat day");
  assert.equal(bt.record.target, 1);
  assert.equal(bt.record.stop, 2);
  assert.equal(bt.record.time, 1);
  // R: +2, -1, -1, (101.7 - 101.3) / 0.8 = +0.5 → avg 0.125
  assert.equal(bt.record.avgR, 0.13);
});

function dailyBars(closes: number[], hl = 0.01): Bar[] {
  return closes.map((c, i) => ({ time: new Date(Date.UTC(2024, 0, 1) + i * DAY).toISOString().slice(0, 10), open: c, high: c * (1 + hl), low: c * (1 - hl), close: c, volume: 1e6 }));
}

test("swing track record: no overlapping trades of one setup, only full holding windows, baseline present", () => {
  // Steady uptrend: 20-day breakouts fire constantly; a new one can't open while one is running.
  const closes = Array.from({ length: 300 }, (_, i) => 100 * Math.pow(1.004, i));
  const bt = swingBacktest(dailyBars(closes), { stopAtr: 2, targetR: 2, maxHoldDays: 20 });
  const r = bt.bySetup.breakout_20d;
  assert.ok(r.trades > 3, `trades ${r.trades}`);
  assert.ok(r.trades < 300 - 29 - 20, "overlapping signals are skipped");
  assert.ok(r.avgR > 0, "a steady uptrend pays the breakout");
  assert.ok(bt.baseline.days === 300 - 1 - 20 - 29 + 1);
  assert.ok(Number.isFinite(bt.baseline.avgR));
  for (const t of r.recent) assert.ok(t.stop < t.entry && t.target > t.entry);
});

test("summarize flags thin samples and explains itself", () => {
  const s = summarize([{ date: "d", entry: 10, stop: 9, target: 12, outcome: "target", exit: 12, R: 2, days: 3 }]);
  assert.equal(s.sample, "thin");
  assert.match(s.verdict, /too few to trust/);
  assert.equal(summarize([]).sample, "none");
});

test("trade plan accepts a fixed stop (intraday) without an ATR", () => {
  const p = buildTradePlan({ symbol: "X", action: "BUY", price: 101.3, stop: { price: 100.5, why: "opening-range midpoint" } }, { ...DEFAULT_PLAN_SETTINGS, minStopPct: 0.001 });
  assert.equal(p.status, "READY");
  assert.equal(p.stop, 100.5);
  assert.equal(p.target, 102.9);
  assert.equal(p.shares, 24); // position cap: 2,500 / 101.3 = 24 (max loss allows 125)
});
