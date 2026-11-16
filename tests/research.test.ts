import assert from "node:assert/strict";
import { test } from "node:test";
import { buildChecklist, tally } from "../lib/checklist";
import { marketStatus, tradingDaysBetween } from "../lib/clock";
import { analyse, type CompanyFacts } from "../lib/earnings";
import { pivots, resistanceBefore, supportAbove, supportResistance } from "../lib/levels";
import { tagText, toFiling } from "../lib/news";
import { buildTradePlan } from "../lib/plan";
import { dailyPool, leanKind, simulate, verdict } from "../lib/timemachine";
import type { Bar, Quote } from "../lib/types";

const DAY = 86_400_000;
const bar = (i: number, c: number, h = c * 1.005, l = c * 0.995): Bar => ({ time: new Date(Date.UTC(2025, 0, 1) + i * DAY).toISOString().slice(0, 10), open: c, high: h, low: l, close: c, volume: 1e6 });

// ---------------------------------------------------------------- levels

test("pivots and support/resistance from a range-bound chart", () => {
  // oscillate between ~90 and ~110 four times: tops near 110, bottoms near 90
  const bars = Array.from({ length: 160 }, (_, i) => bar(i, 100 + 10 * Math.sin((i / 40) * 2 * Math.PI)));
  const pv = pivots(bars);
  assert.ok(pv.some((p) => p.type === "high") && pv.some((p) => p.type === "low"));
  const lv = supportResistance(bars, 100, 2);
  assert.ok(lv.resistances[0].price > 108 && lv.resistances[0].price < 112, `res ${lv.resistances[0].price}`);
  assert.ok(lv.supports[0].price > 88 && lv.supports[0].price < 92, `sup ${lv.supports[0].price}`);
  assert.ok(lv.resistances[0].touches >= 3, "repeated tops group into one level");
  assert.ok(lv.supports[0].distancePct < 0 && lv.resistances[0].distancePct > 0);
  assert.equal(resistanceBefore(lv, 100, 115)?.price, lv.resistances[0].price);
  assert.equal(resistanceBefore(lv, 100, 105), undefined);
  assert.equal(supportAbove(lv, 85, 100)?.price, lv.supports[0].price);
  assert.equal(supportAbove(lv, 95, 100), undefined);
});

// ---------------------------------------------------------------- time machine

test("time machine: seeded, stop-first, and the verdict thresholds match the skill", () => {
  const up = Array.from({ length: 260 }, (_, i) => bar(i, 100 * Math.pow(1.004, i), 100 * Math.pow(1.004, i) * 1.01, 100 * Math.pow(1.004, i) * 0.99));
  const pool = dailyPool(up);
  assert.equal(pool.length, 250);
  const a = simulate(pool, { entry: 100, stop: 96, target: 108 }, 20)!;
  const b = simulate(pool, { entry: 100, stop: 96, target: 108 }, 20)!;
  assert.deepEqual(a, b, "same seed, same numbers");
  assert.ok(Math.abs(a.pTarget + a.pStop + a.pNeither - 1) < 1e-9);
  assert.ok(a.pTarget > a.pStop, "a steady uptrend hits the target first");
  assert.match(a.verdict, /toward the target/);
  assert.equal(a.rAtTarget, 2);

  // a bar touching both the stop and the target counts as the stop
  const wild = Array.from({ length: 40 }, (_, i) => bar(i, 100, 120, 80));
  const w = simulate(dailyPool(wild), { entry: 100, stop: 95, target: 105 }, 5)!;
  assert.equal(w.pStop, 1);
  assert.equal(leanKind(w), "strong-stop");

  assert.equal(simulate(pool, { entry: 100, stop: 101, target: 108 }, 20), null, "stop above entry is refused");
  assert.match(verdict({ ...a, pTarget: 0.33, pStop: 0.67, rAtTarget: 2 }), /^Close to break-even/);
});

// ---------------------------------------------------------------- clock

test("NYSE clock: holidays, early closes, weekends and next open", () => {
  const ny = (s: string, offset = "-05:00") => Date.parse(`${s}${offset}`);
  assert.equal(marketStatus(ny("2026-11-16T10:00:00")).open, true);
  const sat = marketStatus(ny("2026-11-14T10:00:00"));
  assert.equal(sat.open, false);
  assert.equal(sat.reason, "weekend");
  assert.equal(sat.nextOpen?.date, "2026-11-16");
  const thx = marketStatus(ny("2026-11-26T11:00:00"));
  assert.match(thx.reason, /Thanksgiving/);
  const fri = marketStatus(ny("2026-11-27T12:30:00"));
  assert.equal(fri.open, true);
  assert.equal(fri.closesAt, "1:00 PM");
  assert.equal(marketStatus(ny("2026-11-27T13:30:00")).open, false);
  assert.equal(marketStatus(ny("2026-11-16T08:00:00")).nextOpen?.date, "2026-11-16", "before the open: opens today");
  assert.equal(tradingDaysBetween("2026-11-20", "2026-11-30"), 5, "skips the weekend and Thanksgiving");
});

// ---------------------------------------------------------------- news

test("news tags and 8-K item labels follow trader-news", () => {
  assert.deepEqual(tagText("Apple beats earnings, raises guidance"), ["earnings"]);
  assert.ok(tagText("Regulators open antitrust probe into deal").includes("legal"));
  const f = toFiling("ACME CORP", { form: "8-K", filed: "2026-11-10", items: "2.02,9.01", accession: "0000001-26-000001", primaryDocument: "a.htm" }, 1);
  assert.deepEqual(f.labels, ["earnings results"]);
  assert.ok(f.important);
  assert.equal(f.tags[0], "earnings");
  assert.equal(f.link, "https://www.sec.gov/Archives/edgar/data/1/000000126000001/a.htm");
});

// ---------------------------------------------------------------- earnings

test("earnings: quarters, derived Q4, YoY and TTM like trader-analyst", () => {
  const usd = (start: string, end: string, val: number, form = "10-Q", filed = end) => ({ start, end, val, form, filed, fy: Number(end.slice(0, 4)), fp: "Q" });
  const q = (y: number, base: number) => [
    usd(`${y}-01-01`, `${y}-03-31`, base),
    usd(`${y}-04-01`, `${y}-06-30`, base + 10),
    usd(`${y}-07-01`, `${y}-09-30`, base + 20),
    usd(`${y}-01-01`, `${y}-12-31`, 4 * base + 60, "10-K", `${y + 1}-02-01`), // Q4 = base + 30
  ];
  const cf: CompanyFacts = {
    entityName: "ACME",
    facts: {
      "us-gaap": {
        Revenues: { units: { USD: [...q(2024, 100), ...q(2025, 120)] } },
        NetIncomeLoss: { units: { USD: [...q(2024, 10), ...q(2025, 15)] } },
      },
    },
  };
  const r = analyse(cf)!;
  assert.equal(r.rows[0].end, "2025-12-31");
  assert.equal(r.rows[0].revenue, 150);
  assert.ok(r.rows[0].derived);
  assert.equal(r.rows[0].revenueYoY, 15.4); // 150 vs 130
  assert.equal(r.rows[0].netMargin, 30); // 45 / 150
  assert.equal(r.ttm.revenue, 120 + 130 + 140 + 150);
  assert.match(r.changes[0], /Quarter ending 2025-12-31 \(derived from the 10-K\)/);
});

// ---------------------------------------------------------------- checklist

test("checklist turns every signal into explainable lines", () => {
  const bars = Array.from({ length: 160 }, (_, i) => bar(i, 100 + 10 * Math.sin((i / 40) * 2 * Math.PI)));
  const levels = supportResistance(bars, 100, 2);
  const quote: Quote = { symbol: "ACME", name: "Acme", price: 100, change: 4, changePct: 0.04, currency: "USD", asOf: "", source: "yahoo" };
  const plan = buildTradePlan({ symbol: "ACME", action: "BUY", price: 100, atr14: 3 });
  const checks = buildChecklist({
    today: "2026-11-16",
    quote,
    indicators: { sma50: 95, sma200: 105, atr14: 3 },
    relativeStrength: 0.05,
    levels,
    plan,
    nextEarningsDate: "2026-11-20",
    holdDays: 20,
    news: [{ title: "Acme sued over patent", link: "x", publishedAt: "2026-11-15T12:00:00Z" }],
    filings: null,
  });
  const by = Object.fromEntries(checks.map((c) => [c.key, c]));
  assert.equal(by.trend.status, "warn");
  assert.equal(by.rs.status, "pass");
  assert.equal(by.room.status, "warn", "resistance near 110 sits before the 112 target");
  assert.match(by.room.detail, /Resistance at/);
  assert.equal(by.earnings.status, "warn");
  assert.match(by.earnings.detail, /in 4 sessions/);
  assert.equal(by.move.status, "warn");
  assert.equal(by.headlines.status, "warn");
  assert.equal(by.sec.status, "na");
  assert.equal(by.risk.status, "pass");
  const t = tally(checks);
  assert.equal(t.pass + t.warn + t.fail, checks.filter((c) => ["pass", "warn", "fail"].includes(c.status)).length);
});
