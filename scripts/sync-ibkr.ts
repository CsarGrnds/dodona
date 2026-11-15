// Turns the IBKR connector's raw output into trader/portfolio.json.
//
//   1. Claude calls the Interactive Brokers connector (get_account_positions,
//      get_account_summary) and saves each JSON result verbatim to
//      trader/ibkr/positions.json and trader/ibkr/summary.json.
//   2. npm run sync:ibkr
//
// Read-only: nothing here talks to the broker or places orders.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fromIbkr, holdings } from "../lib/portfolio";

const root = process.cwd();
const posPath = resolve(root, process.argv[2] ?? "trader/ibkr/positions.json");
const sumPath = resolve(root, process.argv[3] ?? "trader/ibkr/summary.json");
const outPath = resolve(root, process.env.DODONA_PORTFOLIO ?? "trader/portfolio.json");

function read(p: string): unknown {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    console.error(`Cannot read ${p}: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
}

const pf = fromIbkr(read(posPath), read(sumPath));
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(pf, null, 2) + "\n");

const usd = (v: number) => `$${v.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
console.log(
  `Wrote ${outPath}: ${pf.positions.length} positions, ${usd(pf.grossPositionValue)} invested, ${usd(pf.cash)} cash, ${usd(pf.netLiquidation)} net liquidation.`,
);
for (const h of holdings(pf).slice(0, 5)) {
  const pnl = h.pnlPct * 100;
  console.log(`  ${h.ticker.padEnd(6)} ${(h.weight * 100).toFixed(1).padStart(5)}%  ${usd(h.marketValue).padStart(8)}  ${pnl >= 0 ? "+" : ""}${pnl.toFixed(1)}%`);
}
