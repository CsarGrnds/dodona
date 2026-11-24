import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSession, latestSessionDate, shortWhy, teamTrack } from "../lib/session";
import type { Candidate, Replay } from "../lib/learning";

const c = (symbol: string, at: string, verdict: "take" | "skip" = "skip"): Candidate => ({
  at, date: "2026-11-20", mode: "live", symbol, setup: "orb", trigger: 10, stop: 9, target: 12, verdict,
  why: "Chart 3: one wick at the range high. Time Machine: no edge.", chartScore: 3, marketMode: "normal",
});

test("keeps each stock's last decision, adds the coach's grades, orders and shortlist", () => {
    const cands = [c("AAA", "2026-11-20T15:00:00Z"), c("AAA", "2026-11-20T16:00:00Z", "take"), c("BBB", "2026-11-20T15:30:00Z"), { ...c("OLD", "2026-11-19T15:00:00Z"), date: "2026-11-19" }];
    const replays: Replay[] = [
      { ...cands[1], outcome: "target", R: 2, rightCall: true, triggeredAt: "11:05" },
      { ...cands[2], outcome: "stop", R: -1, rightCall: true },
    ];
    const s = buildSession("2026-11-20", {
      candidates: cands,
      replays,
      reviewedAt: "2026-11-20T21:10:00Z",
      orders: [
        { at: "2026-11-20T10:00:00-05:00", date: "2026-11-20", symbol: "KO", side: "sell", kind: "stop", status: "approved", fingerprint: "f1" },
        { at: "2026-11-20T10:00:05-05:00", date: "2026-11-20", symbol: "KO", side: "sell", kind: "stop", status: "stop-changed", fingerprint: "f1" },
        { at: "2026-11-19T10:00:00-05:00", date: "2026-11-19", symbol: "X", side: "buy", status: "placed" },
      ],
      shortlist: { date: "2026-11-20", kept: [1, 2, 3], dropped: [{ symbol: "ADT", why: "AVOID: deal" }], universe: 5928, spyReturn20: -6.3 },
    });
    assert.deepEqual(s.picks.map((p) => [p.symbol, p.verdict, p.outcome]), [["BBB", "skip", "stop"], ["AAA", "take", "target"]]);
    assert.equal(s.picks[0].why, "Chart 3: one wick at the range high.");
    assert.equal(s.orders.length, 1);
    assert.equal(s.orders[0].status, "stop-changed");
    assert.deepEqual(s.review, { reviewedAt: "2026-11-20T21:10:00Z", right: 2, graded: 2, triggered: 2, skipR: -1, takeR: 2 });
    assert.deepEqual(s.shortlist, { kept: 3, dropped: [{ symbol: "ADT", why: "AVOID: deal" }], universe: 5928, spyReturn20: -6.3 });
  });

test("has no review before the close and no shortlist from another day", () => {
    const s = buildSession("2026-11-20", { candidates: [c("AAA", "2026-11-20T15:00:00Z")], orders: [], shortlist: { date: "2026-11-19", kept: [] } });
    assert.equal(s.review, undefined);
    assert.equal(s.shortlist, undefined);
    assert.equal(s.picks[0].outcome, undefined);
  });

test("picks the newest date and shortens long reasons", () => {
    assert.equal(latestSessionDate(["2026-11-19", "", "2026-11-20"]), "2026-11-20");
    assert.equal(shortWhy("x".repeat(200), 20).length, 20);
  });


test("teamTrack grades the calls across every reviewed session", () => {
  const base = { at: "2026-11-20T15:00:00Z", mode: "live" as const, setup: "orb", trigger: 10, stop: 9, target: 12, why: "x" };
  const t = teamTrack([
    { ...base, date: "2026-11-19", symbol: "A", verdict: "skip", outcome: "stop", R: -1, rightCall: true },
    { ...base, date: "2026-11-19", symbol: "B", verdict: "skip", outcome: "target", R: 2, rightCall: false },
    { ...base, date: "2026-11-20", symbol: "C", verdict: "take", outcome: "target", R: 2, rightCall: true },
    { ...base, date: "2026-11-20", symbol: "D", verdict: "take", outcome: "not-triggered", R: 0, rightCall: null },
  ]);
  assert.deepEqual(t, { sessions: 2, graded: 3, right: 2, pct: 67, grade: "C", takes: 2, takeR: 2, passedUp: 1, passedUpR: 2, avoided: 1, avoidedR: -1 });
  assert.equal(teamTrack([]), undefined);
});
