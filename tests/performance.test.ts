import assert from "node:assert/strict";
import { test } from "node:test";
import { isPeriod, parsePerformance } from "../lib/performance";

// The shape IBKR's /pa/performance returns (fictional account and values).
const raw = (navs: number[], returns: number[], dates = ["20260105", "20260106", "20260107"]) => ({
  nav: { freq: "D", dates, data: [{ id: "U000", idType: "acctid", startNAV: { date: "20260102", val: 1000 }, baseCurrency: "USD", navs }] },
  cps: { freq: "D", dates, data: [{ id: "U000", returns }] },
  pm: "TWR",
});

test("NAV + TWR: no deposits, the NAV change is all gain", () => {
  const p = parsePerformance(raw([1010, 1030.2, 1020.0], [0.01, 0.0302, 0.02]), "1M");
  assert.equal(p.start.date, "2026-01-02");
  assert.equal(p.points[0].date, "2026-01-05");
  assert.equal(p.end, 1020);
  assert.equal(p.navChange, 20);
  assert.equal(p.twr, 0.02);
  assert.equal(p.gain, 20);
  assert.equal(p.netDeposits, 0);
});

test("a mid-period deposit counts as a deposit, not a gain", () => {
  // day 1 +1% (1010); day 2 deposit 1,000, flat (2010); day 3 +1% on 2010 (2030.1)
  const p = parsePerformance(raw([1010, 2010, 2030.1], [0.01, 0.01, 0.0201]), "YTD");
  assert.equal(p.navChange, 1030.1);
  assert.equal(p.gain, 30.1);
  assert.equal(p.netDeposits, 1000);
  assert.ok(isPeriod("YTD") && !isPeriod("5Y"));
  assert.throws(() => parsePerformance({}, "1M"), /no NAV series/);
});
