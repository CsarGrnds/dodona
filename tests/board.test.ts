import assert from "node:assert/strict";
import { test } from "node:test";
import { buildBoard, dueForTeam, latestDecisions, MAX_RECHECKS } from "../lib/board";
import type { PendingRange } from "../lib/pending";

const range = (symbol: string, x: Partial<PendingRange> = {}): PendingRange => ({ symbol, orHigh: 11.03, orLow: 10.77, orMid: 10.9, last: 10.95, vwap: 10.9, belowHighPct: 0.7, relVolume: 0.8, rangePct: 2.4, bars: 30, ...x });
const T = (hhmm: string) => `2026-11-24T${hhmm}:00.000Z`;
const ms = (hhmm: string) => Date.parse(T(hhmm));

test("board: every stock's state, ready ones first, with the team's latest call", () => {
  const b = buildBoard({
    date: "2026-11-24",
    at: T("17:00"),
    status: { GPK: range("GPK"), CROX: { why: "already broke out", price: 160.5 }, KO: { why: "held or blocked" }, BHC: range("BHC", { relVolume: 1.4 }) },
    decisions: latestDecisions(
      [
        { at: T("15:40"), date: "2026-11-24", mode: "live", symbol: "GPK", verdict: "skip", why: "chart 3", chartScore: 3 },
        { at: T("16:20"), date: "2026-11-24", mode: "live", symbol: "GPK", verdict: "skip", why: "volume 0.84", recheck: ["volume", "nonsense"] },
        { at: T("16:20"), date: "2026-11-24", mode: "paper", symbol: "BHC", verdict: "take", why: "practice" },
      ],
      "2026-11-24",
    ),
    worked: { GPK: { at: T("16:15"), rechecks: 0 } },
  });
  assert.deepEqual(b.rows.map((r) => [r.symbol, r.state]), [["BHC", "ready"], ["GPK", "ready"], ["CROX", "broke out"], ["KO", "out"]]);
  const gpk = b.rows.find((r) => r.symbol === "GPK")!;
  assert.equal(gpk.decision?.why, "volume 0.84"); // the latest call wins
  assert.deepEqual(gpk.decision?.recheck, ["volume"]); // unknown reasons are dropped
  assert.match(gpk.watchingFor!, /relative volume/);
  assert.equal(b.rows.find((r) => r.symbol === "BHC")!.decision, undefined); // practice calls aren't on the real board
});

test("due for the team: new ready stocks, and skips whose every re-check reason cleared", () => {
  const decisions = {
    GPK: { at: T("16:20"), verdict: "skip" as const, why: "volume", recheck: ["volume" as const] },
    HGV: { at: T("16:20"), verdict: "skip" as const, why: "single wick" }, // not re-checkable: final for the day
    BHC: { at: T("16:20"), verdict: "skip" as const, why: "volume and market", recheck: ["volume" as const, "market" as const] },
  };
  const worked = { GPK: { at: T("16:15"), rechecks: 0 }, HGV: { at: T("16:15"), rechecks: 0 }, BHC: { at: T("16:15"), rechecks: 0 } };
  const status = { GPK: range("GPK", { relVolume: 1.1 }), HGV: range("HGV", { relVolume: 2 }), BHC: range("BHC", { relVolume: 1.2 }), REPL: range("REPL") };
  const below = buildBoard({ date: "2026-11-24", at: T("17:00"), status, decisions, worked, market: { spy: 713, vwap: 715, aboveVwap: false } });
  assert.deepEqual(dueForTeam(below, ms("17:00")), { fresh: ["REPL"], recheck: [{ symbol: "GPK", reasons: ["volume"] }] }); // BHC waits for the market
  const above = buildBoard({ date: "2026-11-24", at: T("17:00"), status, decisions, worked, market: { spy: 716, vwap: 715, aboveVwap: true } });
  assert.deepEqual(dueForTeam(above, ms("17:00")).recheck.map((x) => x.symbol), ["BHC", "GPK"]);
  // too soon after the last wake, or no new decision since it, or out of re-checks: nothing
  assert.deepEqual(dueForTeam(above, ms("16:30")).recheck, []);
  const noNewCall = buildBoard({ date: "2026-11-24", at: T("17:00"), status, decisions, worked: { ...worked, GPK: { at: T("16:40"), rechecks: 1 } }, market: above.market });
  assert.ok(!dueForTeam(noNewCall, ms("17:30")).recheck.some((x) => x.symbol === "GPK"));
  const spent = buildBoard({ date: "2026-11-24", at: T("17:00"), status, decisions, worked: { ...worked, GPK: { at: T("16:15"), rechecks: MAX_RECHECKS } }, market: above.market });
  assert.ok(!dueForTeam(spent, ms("17:30")).recheck.some((x) => x.symbol === "GPK"));
  assert.equal(spent.rows.find((r) => r.symbol === "GPK")!.watchingFor, undefined);
  // a stock that broke out isn't re-checked: the buy-stop's moment is gone
  const gone = buildBoard({ date: "2026-11-24", at: T("17:00"), status: { ...status, GPK: { why: "already broke out" } }, decisions, worked, market: above.market });
  assert.ok(!dueForTeam(gone, ms("17:30")).recheck.some((x) => x.symbol === "GPK"));
});
