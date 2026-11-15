import assert from "node:assert/strict";
import { test } from "node:test";
import { computeIndicators } from "../lib/indicators";
import { buildTradePlan, DEFAULT_PLAN_SETTINGS } from "../lib/plan";
import { findHolding, fromIbkr, holdings, parsePortfolio } from "../lib/portfolio";
import { dividendSignal } from "../lib/signals";
import type { Bar } from "../lib/types";

// Shape of the IBKR connector's get_account_positions / get_account_summary output (synthetic values).
const POS = {
  positions: [
    { contract_id: 1, contract_description: "aaa", position: 10, market_price: 50, market_value: 500, currency: "USD", average_price: 40, unrealized_pnl: 100, daily_pnl: 2, asset_class: "STK" },
    { contract_id: 2, contract_description: "BBB", position: 1.5, market_price: 200, market_value: 300, currency: "USD", average_price: 250, unrealized_pnl: -75, daily_pnl: -1, asset_class: "STK" },
    { contract_id: 3, contract_description: "CCC", position: 0, market_price: 10, market_value: 0, average_price: 10, asset_class: "STK" },
  ],
};
const SUM = { currency: "USD", net_liquidation: 1000, gross_position_value: 800, total_cash_value: 200, buying_power: 200 };

test("fromIbkr maps connector output to the skills' portfolio format", () => {
  const pf = fromIbkr(POS, SUM, new Date("2026-11-14T12:00:00Z"));
  assert.equal(pf.positions.length, 2, "zero-share rows are dropped");
  assert.equal(pf.cash, 200);
  assert.equal(pf.netLiquidation, 1000);
  const a = pf.positions[0];
  assert.equal(a.ticker, "AAA", "sorted by value, upper-cased");
  assert.equal(a.avgCost, 40);
  assert.deepEqual(a.lots, [{ id: "AAA-ibkr", date: "2026-11-14", shares: 10, cost: 400 }]);
});

test("holdings: weight vs net liquidation and P&L vs average cost", () => {
  const h = holdings(fromIbkr(POS, SUM));
  assert.equal(h[0].weight, 0.5);
  assert.ok(Math.abs(h[0].pnlPct - 0.25) < 1e-9);
  assert.ok(Math.abs(h[1].pnlPct + 0.2) < 1e-9);
});

test("parsePortfolio round-trips and accepts the skills' minimal file", () => {
  const pf = fromIbkr(POS, SUM);
  assert.deepEqual(parsePortfolio(JSON.parse(JSON.stringify(pf))), pf);
  const minimal = parsePortfolio({ cash: 500, positions: [{ ticker: "tsla", shares: 8, lots: [{ id: "x", date: "2026-10-19", shares: 8, cost: 2913.44 }] }] });
  assert.equal(minimal!.positions[0].ticker, "TSLA");
  assert.ok(Math.abs(minimal!.positions[0].avgCost - 364.18) < 1e-9);
  assert.equal(parsePortfolio({ nope: 1 }), null);
  assert.equal(findHolding(minimal, "tsla")!.shares, 8);
});

test("trade plan sizes against the real account and counts what is already held", () => {
  const input = { symbol: "X", action: "BUY" as const, price: 100, atr14: 1 }; // risk 2/share → max loss allows 50
  // 25% of 4,000 net liq = 1,000; 600 already held → room 400 → 4 shares
  const p = buildTradePlan(input, DEFAULT_PLAN_SETTINGS, { netLiquidation: 4000, cash: 3000, heldValue: 600 });
  assert.equal(p.shares, 4);
  assert.equal(p.sizedBy, "position cap");
  // cash binds: only $250 cash
  const q = buildTradePlan(input, DEFAULT_PLAN_SETTINGS, { netLiquidation: 100_000, cash: 250, heldValue: 0 });
  assert.equal(q.shares, 2);
  assert.equal(q.sizedBy, "cash");
  // already over the cap → blocked
  const r = buildTradePlan(input, DEFAULT_PLAN_SETTINGS, { netLiquidation: 4000, cash: 3000, heldValue: 1500 });
  assert.equal(r.status, "BLOCKED");
});

test("dividend: token yield is not scored as cheap vs a near-zero 5y average", () => {
  const bars: Bar[] = Array.from({ length: 260 }, (_, i) => {
    const c = 100 + Math.sin(i / 7) * 3;
    return { time: new Date(Date.UTC(2025, 0, 1) + i * 86_400_000).toISOString().slice(0, 10), open: c, high: c * 1.01, low: c * 0.99, close: c, volume: 1e6 };
  });
  const sig = dividendSignal(100, computeIndicators(bars), { dividendYield: 0.0061, fiveYearAvgDividendYield: 0.0003, dividendRate: 0.04, payoutRatio: 0.035 });
  const f = sig.factors.find((x) => x.name === "Dividend" || x.name === "Yield vs 5y average")!;
  assert.equal(f.name, "Dividend");
  assert.equal(f.score, -1);
  // levels fall back to the 200-day average instead of rate / tiny-yield (0.04 / 0.00033 ≈ 121)
  assert.ok(sig.levels.buyBelow! < 100, `buyBelow ${sig.levels.buyBelow}`);
});
