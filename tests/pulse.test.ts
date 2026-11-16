import assert from "node:assert/strict";
import { test } from "node:test";
import { pulse, type PulseHolding } from "../lib/pulse";

const h = (ticker: string, shares: number, avgCost: number, price: number, change: number, extra: Partial<PulseHolding> = {}): PulseHolding => ({
  ticker,
  shares,
  avgCost,
  price,
  change,
  changePct: change / (price - change),
  ...extra,
});

test("winners, losers and totals", () => {
  const p = pulse([h("AAA", 10, 50, 110, 10, { sector: "Tech" }), h("BBB", 5, 100, 90, -2, { sector: "Energy" }), h("CCC", 1, 10, 0, 0, { error: "no quote" })], 0);
  assert.equal(p.day.pnl, 90); // 100 − 10
  assert.equal(p.day.prevValue, 1460); // 10×100 + 5×92
  assert.deepEqual(p.winners.map((m) => m.ticker), ["AAA"]);
  assert.deepEqual(p.losers.map((m) => [m.ticker, m.pnl]), [["BBB", -10]]);
  assert.equal(p.total.pnl, 550); // 600 − 50
  assert.deepEqual(p.totalLosers.map((m) => m.ticker), ["BBB"]);
  assert.equal(p.sectors[0].sector, "Tech");
  assert.match(p.whyTotal.join(" "), /1 of 2 positions are above their cost/);
  const t = pulse([h("WIN", 1, 100, 150, 0), h("BIG", 10, 100, 80, 0)], 0); // +50 and −200 → −150
  assert.match(t.whyTotal.join(" "), /BIG alone \(−\$200\.00\) is more than the whole −\$150\.00: without it you'd be \+\$50\.00/);
});

test("why: market vs stock-specific, one position deciding the day, big movers' headlines", () => {
  // market −1%, beta 1: market alone says −$10 on $1,000; the day is +$5 thanks to one stock
  const p = pulse(
    [
      h("UPP", 2, 100, 115, 15, { beta: 1, headline: { title: "UPP wins a contract", link: "https://example.com", publisher: "Wire" } }),
      h("DWN", 8, 100, 97.5, -3.125, { beta: 1 }),
    ],
    -0.01,
  );
  assert.equal(p.day.pnl, 5);
  assert.equal(p.day.marketExplains, -10.05); // prev value 2×100 + 8×100.625 = 1,005
  assert.equal(p.day.stockSpecific, 15.05);
  const why = p.why.join("\n");
  assert.match(why, /Against the market: SPY −1\.0%/);
  assert.match(why, /UPP alone \(\+\$30\.00\) is more than the whole day's \+\$5\.00: without it the portfolio would be down/);
  assert.match(why, /UPP moved \+15\.0%\. Latest headline: “UPP wins a contract” \(Wire\)/);
  assert.match(why, /DWN moved −3\.1%, with no headline/);

  const m = pulse([h("A", 10, 100, 99, -1, { beta: 1 }), h("B", 10, 100, 99, -1, { beta: 1 })], -0.01);
  assert.match(m.why.join("\n"), /Mostly the market/);
});
