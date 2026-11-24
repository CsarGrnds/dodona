import assert from "node:assert/strict";
import { test } from "node:test";
import { reviewDay } from "../lib/data/liveRun";
import { auditStats, ruleAudit } from "../lib/learning";
import type { IntradayBar } from "../lib/setups";

// Monday 2026-11-23, 9:30 AM New York = 14:30 UTC
const T0 = Date.parse("2026-11-23T14:30:00Z");
const bar = (i: number, open: number, high: number, low: number, close: number): IntradayBar => ({ t: T0 + i * 5 * 60_000, open, high, low, close, volume: 1000 });
const day = (third: number, later: Array<[number, number, number, number]>) => [bar(0, 100, 101, 99, 100.5), bar(1, 100.5, 102, 100, 101.5), bar(2, 101.5, 101.9, 100.8, third), ...later.map((x, i) => bar(3 + i, ...x))];

test("rule audit: what the 9:46 scan would have done with each shortlisted stock, and the outcome anyway", () => {
  const rows = ruleAudit("2026-11-23", {
    // range 99-102 (2.9%), last 101.8 near the high, above VWAP: the scan passes it; it breaks out and runs to 2R (108)
    WIN: day(101.8, [[101.8, 102.5, 101.5, 102.4], [102.4, 108.2, 102.3, 108], [108, 108, 107, 107.5]]),
    // last 99.3 is 2.6% under the high: kept out; it triggers later and stops out
    FAR: day(99.3, [[99.3, 102.2, 99.2, 102], [102, 102, 98.8, 98.9], [98.9, 99, 98.5, 98.7]]),
  });
  const win = rows.find((r) => r.symbol === "WIN")!, far = rows.find((r) => r.symbol === "FAR")!;
  assert.equal(win.blockedBy, null);
  assert.equal(win.trigger, 102);
  assert.equal(win.stop, 99);
  assert.equal(win.outcome, "target");
  assert.equal(win.R, 2);
  assert.equal(far.blockedBy, "too far under the range high");
  assert.equal(far.outcome, "stop");
  const st = auditStats(rows);
  assert.deepEqual(st["passed the scan"], { n: 1, triggered: 1, avgR: 2 });
  assert.equal(st["too far under the range high"].n, 1);
  assert.ok(st["too far under the range high"].avgR < 0);
});

test("review day: today after the close, else the last trading day; never during the session", () => {
  assert.equal(reviewDay(new Date("2026-11-23T21:30:00Z")), "2026-11-23"); // Mon 4:30 PM NY
  assert.equal(reviewDay(new Date("2026-11-23T17:00:00Z")), undefined); // Mon noon NY: the session
  assert.equal(reviewDay(new Date("2026-11-24T13:00:00Z")), "2026-11-23"); // Tue 8 AM NY: catch up Monday
  assert.equal(reviewDay(new Date("2026-11-22T17:00:00Z")), "2026-11-20"); // Sunday: Friday
});
