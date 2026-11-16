// Writes docs/demo/portfolio.json: a FICTIONAL portfolio for screenshots and demos, priced at
// today's live Yahoo quotes. Nothing here comes from a real account.
//
//   npm run demo:portfolio
//
// Run Dodona against it with DODONA_PORTFOLIO=docs/demo/portfolio.json (see scripts/screenshots.sh).
import { mkdirSync, writeFileSync } from "node:fs";
import { yahooQuote } from "../lib/data/yahoo";

// ticker, shares, average cost: made up, picked to show winners, losers and a few stops' cases
const HOLDINGS: Array<[string, number, number]> = [
  ["AAPL", 25, 182.4],
  ["MSFT", 12, 395.1],
  ["NVDA", 40, 118.75],
  ["KO", 60, 58.3],
  ["JNJ", 20, 152.6],
  ["XOM", 30, 112.4],
  ["PG", 15, 158.2],
  ["COST", 4, 835.0],
  ["SCHD", 150, 26.4],
  ["AMZN", 18, 231.5],
];
const CASH = 4200;

async function main() {
  const positions = [];
  for (const [ticker, shares, avgCost] of HOLDINGS) {
    const q = await yahooQuote(ticker);
    const r2 = (v: number) => Math.round(v * 100) / 100;
    positions.push({
      ticker,
      shares,
      avgCost,
      marketPrice: q.price,
      marketValue: r2(shares * q.price),
      unrealizedPnl: r2(shares * (q.price - avgCost)),
      dailyPnl: r2(shares * q.change),
      assetClass: "STK",
      lots: [{ id: `${ticker}-demo`, date: "2025-06-02", shares, cost: r2(shares * avgCost) }],
    });
  }
  positions.sort((a, b) => b.marketValue - a.marketValue);
  const gross = positions.reduce((s, p) => s + p.marketValue, 0);
  const pf = {
    source: "ibkr",
    demo: true,
    syncedAt: new Date().toISOString(),
    currency: "USD",
    cash: CASH,
    netLiquidation: Math.round((gross + CASH) * 100) / 100,
    grossPositionValue: Math.round(gross * 100) / 100,
    buyingPower: CASH * 2,
    positions,
  };
  mkdirSync("docs/demo", { recursive: true });
  writeFileSync("docs/demo/portfolio.json", JSON.stringify(pf, null, 2) + "\n");
  console.log(`docs/demo/portfolio.json: ${positions.length} fictional positions, net liquidation $${pf.netLiquidation.toLocaleString()}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
