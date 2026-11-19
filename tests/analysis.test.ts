import assert from "node:assert/strict";
import { test } from "node:test";
import { buildAnalysis, chartFor, parseChart, type ChartRef } from "../lib/analysis";
import type { Candidate } from "../lib/learning";

// 2026-11-18, New York is UTC-5
const C = (sym: string, utc: string, extra: Partial<Candidate> = {}): Candidate => ({ at: `2026-11-18T${utc}:00.000Z`, date: "2026-11-18", mode: "live", symbol: sym, setup: "orb", trigger: 10, stop: 9.5, target: 11, verdict: "skip", why: "w", ...extra });
const charts = ["DUK-2026-11-18-1124.png", "DUK-2026-11-18-1400.png", "SNAP-2026-11-18-1125.png", "SPY-2026-11-18-1122.png", "SPY-2026-11-18-1427.png", "COO-2026-11-18-1428.png", "../etc-2026-11-18-1200.png", "notes.json"]
  .map(parseChart)
  .filter((c): c is ChartRef => !!c);

test("parseChart takes only SYM-DATE-HHMM.png", () => {
  assert.equal(charts.length, 6);
  assert.deepEqual(parseChart("BRK.B-2026-11-18-0945.png"), { file: "BRK.B-2026-11-18-0945.png", symbol: "BRK.B", date: "2026-11-18", minute: 585 });
  assert.equal(parseChart("a/../x-2026-11-18-0945.png"), undefined);
});

test("chartFor picks the chart drawn just before the decision", () => {
  assert.equal(chartFor("DUK", "2026-11-18", 11 * 60 + 25, charts), "DUK-2026-11-18-1124.png");
  assert.equal(chartFor("DUK", "2026-11-18", 14 * 60 + 5, charts), "DUK-2026-11-18-1400.png");
  assert.equal(chartFor("DUK", "2026-11-18", 9 * 60 + 50, charts), "DUK-2026-11-18-1124.png", "nearest when none before");
  assert.equal(chartFor("PPL", "2026-11-18", 600, charts), undefined);
});

test("buildAnalysis: runs, market chart, replays and tickets", () => {
  const cands = [C("DUK", "16:25"), C("SNAP", "16:25:30".slice(0, 5), { verdict: "take", chartScore: 4, marketMode: "defensive" }), C("COO", "19:28", { marketMode: "normal" }), C("DUK", "15:00", { date: "2026-11-17", at: "2026-11-17T15:00:00.000Z" })];
  const replays = [{ ...cands[0], outcome: "close" as const, R: -0.14, rightCall: true }];
  const a = buildAnalysis({ candidates: cands, charts, replays, tickets: { SNAP: { status: "staged", qty: 3 } } });
  assert.equal(a.date, "2026-11-18");
  assert.deepEqual(a.dates, ["2026-11-18", "2026-11-17"]);
  assert.equal(a.runs.length, 2, "11:25 and 14:28 are separate runs");
  const [late, early] = a.runs;
  assert.equal(late.cards[0].symbol, "COO");
  assert.equal(late.marketChart, "SPY-2026-11-18-1427.png");
  assert.equal(late.marketMode, "normal");
  assert.equal(early.marketChart, "SPY-2026-11-18-1122.png");
  assert.equal(early.marketMode, "defensive");
  const duk = early.cards.find((c) => c.symbol === "DUK")!;
  assert.equal(duk.chart, "DUK-2026-11-18-1124.png");
  assert.equal(duk.review?.R, -0.14);
  assert.equal(early.cards.find((c) => c.symbol === "SNAP")?.ticket?.qty, 3);
  assert.deepEqual(a.totals, { looked: 3, taken: 1, tickets: 1, reviewed: 1, rightCalls: 1, avgR: -0.14 });
  assert.equal(buildAnalysis({ candidates: cands, charts, date: "2026-11-17" }).totals.looked, 1);
});
