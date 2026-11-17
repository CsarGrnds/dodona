import assert from "node:assert/strict";
import { test } from "node:test";
import { nyEpoch } from "../lib/clock";
import {
  closePosition,
  COMMISSION,
  dailyPnl,
  deskStats,
  findExit,
  markDay,
  newDesk,
  normalizeDeskRules,
  openPosition,
  parseDesk,
  raiseStop,
  riskGate,
  rulesVerdict,
  sizeTrade,
  type DeskPosition,
  type PriceBar,
} from "../lib/desk";
import { parseDeskDecision } from "../lib/deskAgent";
import type { TrackRecord } from "../lib/backtest";

const DAY = "2026-11-16"; // a Monday
const at = (minute: number, date = DAY) => nyEpoch(date, minute);
const rules = normalizeDeskRules({ budget: 200, cash_buffer_pct: 20, max_loss_per_trade_usd: 50, max_daily_loss_usd: 150 });

test("rules: config values, defaults for the rest", () => {
  assert.equal(rules.budget, 200);
  assert.equal(rules.cash_buffer_pct, 20);
  assert.equal(rules.max_trades_per_day, 3);
  assert.equal(rules.flat_by, "15:55");
  assert.equal(rules.require_stop, true);
  assert.deepEqual(normalizeDeskRules({ blocked: ["tsla"] }).blocked, ["TSLA"]);
});

test("sizing: the position cap decides on a $200 account", () => {
  const sz = sizeTrade(rules, 20, 19, 200, 200);
  assert.ok(!("refused" in sz));
  if ("refused" in sz) return;
  // max loss 50/1 = 50, position cap 150/20 = 7, max order 4000/20 = 200, cash (200 − 40)/20.01 ≈ 7
  assert.equal(sz.qty, 7);
  assert.equal(sz.decidedBy, "position cap");
  assert.equal(sz.maxLoss, 7);
});

test("sizing: refuses a share over the cap and a stop above the entry", () => {
  const big = sizeTrade(rules, 400, 390, 200, 200);
  assert.ok("refused" in big && /position cap/.test(big.refused));
  const bad = sizeTrade(rules, 20, 21, 200, 200);
  assert.ok("refused" in bad && /not below/.test(bad.refused));
});

test("sizing: refuses a trade whose fees would eat the risk", () => {
  // 1 share of a $7.45 stock with a $0.59 stop: $0.70 of fees against $0.59 of risk
  const tiny = sizeTrade(normalizeDeskRules({ ...rules, max_position_pct: 5 }), 7.45, 6.86, 200, 200);
  assert.ok("refused" in tiny && /too small/.test(tiny.refused));
});

test("sizing: cash already in positions counts against the buffer", () => {
  // equity 200, 100 already invested: 200 − 40 buffer − 100 invested = 60 usable
  const sz = sizeTrade(rules, 10, 9, 100, 200);
  assert.ok(!("refused" in sz));
  if (!("refused" in sz)) assert.equal(sz.qty, 5);
});

test("risk gate: window, reward:risk, trades per day, duplicates", () => {
  const s = newDesk(200, new Date(at(600)).toISOString());
  const p = { symbol: "F", style: "day" as const, entry: 12, stop: 11.5, target: 13 };
  assert.deepEqual(riskGate(rules, s, p, at(600), true), { ok: true });
  assert.match((riskGate(rules, s, p, at(575), true) as { reason: string }).reason, /before 09:45/);
  assert.match((riskGate(rules, s, p, at(600), false) as { reason: string }).reason, /closed/);
  assert.match((riskGate(rules, s, { ...p, target: 12.2 }, at(600), true) as { reason: string }).reason, /reward:risk/);
  openPosition(s, { symbol: "F", style: "day", setup: "x", qty: 1, entry: 12, stop: 11.5, target: 13, openedAt: new Date(at(600)).toISOString(), entryDate: DAY, maxHoldDays: 1, by: "rules", thesis: "" }, new Date(at(600)).toISOString());
  assert.match((riskGate(rules, s, p, at(605), true) as { reason: string }).reason, /already holding/);
  for (const sym of ["A", "B"]) openPosition(s, { symbol: sym, style: "day", setup: "x", qty: 1, entry: 10, stop: 9.9, target: 11, openedAt: new Date(at(610)).toISOString(), entryDate: DAY, maxHoldDays: 1, by: "rules", thesis: "" }, new Date(at(610)).toISOString());
  assert.match((riskGate(rules, s, { ...p, symbol: "T" }, at(615), true) as { reason: string }).reason, /3 trades today/);
});

test("risk gate: the daily loss limit counts realized losses and open risk", () => {
  const tight = normalizeDeskRules({ ...rules, max_daily_loss_usd: 20 });
  const s = newDesk(200, new Date(at(600)).toISOString());
  const pos = openPosition(s, { symbol: "A", style: "day", setup: "x", qty: 10, entry: 10, stop: 8, target: 14, openedAt: new Date(at(600)).toISOString(), entryDate: DAY, maxHoldDays: 1, by: "rules", thesis: "" }, new Date(at(600)).toISOString());
  // open risk 10 × 2 = 20 fills the $20 limit
  assert.match((riskGate(tight, s, { symbol: "B", style: "day", entry: 5, stop: 4.9, target: 6 }, at(605), true) as { reason: string }).reason, /daily limit/);
  closePosition(s, pos.id, 8, new Date(at(620)).toISOString(), "stop", "stop");
  assert.match((riskGate(tight, s, { symbol: "B", style: "day", entry: 5, stop: 4.9, target: 6 }, at(625), true) as { reason: string }).reason, /daily loss limit is hit/);
});

const bar = (minute: number, o: number, h: number, l: number, c: number, date = DAY): PriceBar => ({ t: at(minute, date), open: o, high: h, low: l, close: c, minutes: 5 });
const pos = (style: "day" | "swing", openedMin = 600): Pick<DeskPosition, "style" | "stop" | "target" | "openedAt" | "entryDate"> => ({ style, stop: 9.5, target: 11, openedAt: new Date(at(openedMin)).toISOString(), entryDate: DAY });

test("exits: target, stop, gaps, and both in one bar counts as the stop", () => {
  const now = at(900);
  assert.equal(findExit(pos("day"), [bar(605, 10, 10.4, 9.9, 10.3), bar(610, 10.3, 11.2, 10.2, 11.1)], 955, now)?.reason, "target");
  const stop = findExit(pos("day"), [bar(605, 10, 10.1, 9.4, 9.6)], 955, now);
  assert.deepEqual([stop?.reason, stop?.price], ["stop", 9.5]);
  const gap = findExit(pos("swing"), [bar(570, 9.2, 9.3, 9.0, 9.1, "2026-11-17")], 955, at(900, "2026-11-17"));
  assert.deepEqual([gap?.reason, gap?.price], ["stop", 9.2]);
  assert.equal(findExit(pos("day"), [bar(605, 10, 11.5, 9.0, 10)], 955, now)?.reason, "stop");
});

test("exits: bars before the entry and still-forming bars are ignored", () => {
  assert.equal(findExit(pos("day", 610), [bar(600, 10, 12, 9, 10)], 955, at(700)), null);
  assert.equal(findExit(pos("day"), [bar(605, 10, 12, 10, 11)], 955, at(607)), null);
});

test("exits: day trades go out at the flat-by bar, or the last close if the session ended", () => {
  const flat = findExit(pos("day"), [bar(950, 10, 10.2, 9.9, 10.1), bar(955, 10.1, 10.3, 10, 10.2)], 955, at(956));
  assert.deepEqual([flat?.reason, flat?.price], ["flat-by", 10.1]);
  const late = findExit(pos("day"), [bar(940, 10, 10.2, 9.9, 10.05), bar(570, 10.4, 10.5, 10.3, 10.4, "2026-11-17")], 955, at(600, "2026-11-17"));
  assert.deepEqual([late?.reason, late?.price], ["flat-by", 10.05]);
  // a swing trade simply carries on
  assert.equal(findExit(pos("swing"), [bar(955, 10.1, 10.3, 10, 10.2)], 955, at(970)), null);
});

test("ledger: P&L after slippage and fees, R from the first stop, cash round trip", () => {
  const s = newDesk(200, new Date(at(600)).toISOString());
  const p = openPosition(s, { symbol: "F", style: "day", setup: "ORB", qty: 10, entry: 10, stop: 9.5, target: 11, openedAt: new Date(at(600)).toISOString(), entryDate: DAY, maxHoldDays: 1, by: "claude", thesis: "t" }, new Date(at(600)).toISOString());
  assert.equal(s.cash, 200 - 100 - COMMISSION);
  const t = closePosition(s, p.id, 11, new Date(at(700)).toISOString(), "target", "target hit")!;
  assert.equal(t.exit, 10.9945); // 11 less 0.05% slippage
  assert.equal(t.pnl, 9.25); // 9.945 − 0.70 fees
  assert.equal(t.R, 1.85); // 9.25 / (10 × 0.5)
  assert.equal(s.cash, 209.25);
  assert.equal(s.positions.length, 0);
});

test("stops only go up and stay under the price", () => {
  const s = newDesk(200, new Date(at(600)).toISOString());
  const p = openPosition(s, { symbol: "F", style: "swing", setup: "x", qty: 1, entry: 10, stop: 9, target: 12, openedAt: new Date(at(600)).toISOString(), entryDate: DAY, maxHoldDays: 20, by: "claude", thesis: "" }, new Date(at(600)).toISOString());
  p.lastPrice = 11;
  assert.equal(raiseStop(p, 8.5).ok, false);
  assert.equal(raiseStop(p, 11.2).ok, false);
  assert.equal(raiseStop(p, 10.017).ok, true);
  assert.equal(p.stop, 10.01);
  assert.equal(p.initialStop, 9);
});

test("history: one row per day, P&L from the previous mark, stats", () => {
  const s = newDesk(200, new Date(at(600)).toISOString());
  const a = openPosition(s, { symbol: "A", style: "day", setup: "ORB", qty: 10, entry: 10, stop: 9.5, target: 11, openedAt: new Date(at(600)).toISOString(), entryDate: DAY, maxHoldDays: 1, by: "rules", thesis: "" }, new Date(at(600)).toISOString());
  closePosition(s, a.id, 11, new Date(at(700)).toISOString(), "target", "");
  markDay(s, at(700));
  markDay(s, at(900)); // same day: replaced, not added
  const next = "2026-11-17";
  const b = openPosition(s, { symbol: "B", style: "day", setup: "20-day breakout", qty: 10, entry: 10, stop: 9.5, target: 11, openedAt: new Date(at(600, next)).toISOString(), entryDate: next, maxHoldDays: 1, by: "claude", thesis: "" }, new Date(at(600, next)).toISOString());
  closePosition(s, b.id, 9.5, new Date(at(650, next)).toISOString(), "stop", "");
  markDay(s, at(700, next));
  const days = dailyPnl(s);
  assert.deepEqual(days.map((d) => [d.date, d.pnl]), [[DAY, 9.25], [next, -5.75]]);
  const st = deskStats(s, at(700, next));
  assert.equal(st.trades, 2);
  assert.equal(st.winRate, 0.5);
  assert.equal(st.profitFactor, 1.61);
  assert.equal(st.today?.pnl, -5.75);
  assert.equal(st.greenDays, 1);
  assert.equal(st.redDays, 1);
  assert.deepEqual(st.streak, { kind: "loss", n: 1 });
  assert.ok(st.maxDrawdown < 0);
  assert.equal(st.byAgent.claude.trades, 1);
  assert.equal(st.bySetup[0].setup, "ORB");
});

test("rules engine: needs a profitable track record and a market that isn't falling", () => {
  const rec = (trades: number, avgR: number): TrackRecord => ({ trades, target: 0, stop: 0, time: 0, winRate: 0.5, avgR, totalR: avgR * trades, verdict: "v", sample: trades === 0 ? "none" : trades < 10 ? "thin" : "ok", recent: [] });
  assert.equal(rulesVerdict({ record: rec(20, 0.4) }).take, true);
  assert.equal(rulesVerdict({ record: rec(20, 0.4), marketTrend: "down" }).take, false);
  assert.equal(rulesVerdict({ record: rec(20, 0.05) }).take, false);
  assert.equal(rulesVerdict({ record: rec(5, 0.3) }).take, false);
  assert.equal(rulesVerdict({ record: rec(5, 0.8) }).take, true);
  assert.equal(rulesVerdict({ record: rec(0, 0) }).take, false);
});

test("Claude's answer: bad items dropped, numbers checked", () => {
  const d = parseDeskDecision({
    summary: "Choppy tape.",
    positions: [{ id: "F-1", action: "raise_stop", new_stop: 10.2, why: "higher low" }, { id: "X", action: "sell_all" }],
    entries: [{ key: "k1", decision: "buy", stop: "9", target: 12, confidence: 3, why: "clean break" }, { key: "k2", decision: "maybe" }],
  });
  assert.equal(d.positions.length, 1);
  assert.equal(d.entries.length, 1);
  assert.equal(d.entries[0].stop, null);
  assert.equal(d.entries[0].confidence, 1);
});

test("a corrupt ledger file is rejected, a good one keeps its fields", () => {
  assert.equal(parseDesk({ version: 2 }), null);
  assert.equal(parseDesk("x"), null);
  const s = newDesk(200, "2026-11-16T15:00:00.000Z");
  assert.deepEqual(parseDesk(JSON.parse(JSON.stringify(s))), s);
});
