// IBKR Client Portal Gateway helper for the /ibkr-gateway skill (read-only).
//
//   npm run ibkr -- status   is the gateway running, and is it logged in?
//   npm run ibkr -- sync     read positions + summary and write trader/portfolio.json
//   npm run ibkr -- where    where the gateway is installed and how to start it
//
// Exit codes: 0 ok · 2 gateway not running · 3 running but not logged in · 1 other error.
// Never prints account numbers in full. Never places, changes or cancels orders.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { gatewayStatus, GatewayError, syncFromGateway } from "../lib/data/ibkr";
import { holdings } from "../lib/portfolio";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* optional */
}
// (the gateway URL and account are read from the environment when each call runs, so loading
// .env.local here, after the imports, still applies)

const dir = process.env.IBKR_GATEWAY_DIR || join(homedir(), "clientportal.gw");
const mask = (id?: string) => (id ? `…${id.slice(-3)}` : "?");
const usd = (v: number) => `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const cmd = process.argv[2] ?? "status";

async function main(): Promise<number> {
  if (cmd === "where") {
    const ok = existsSync(join(dir, "bin", "run.sh"));
    console.log(ok ? `Gateway installed at ${dir}` : `Gateway NOT found at ${dir} (set IBKR_GATEWAY_DIR or install it)`);
    console.log(`Start it (long-running, in its own terminal): cd ${dir} && bin/run.sh root/conf.yaml`);
    return ok ? 0 : 1;
  }
  if (cmd === "status") {
    const st = await gatewayStatus();
    if (st.state === "ready") console.log(`READY: logged in at ${st.url}, account ${mask(st.account)}`);
    else if (st.state === "login") console.log(`LOGIN NEEDED: the gateway is running at ${st.url} but not logged in. The user must log in at ${st.url}`);
    else console.log(`DOWN: no gateway at ${st.url} (${st.message ?? "not reachable"})`);
    return st.state === "ready" ? 0 : st.state === "login" ? 3 : 2;
  }
  if (cmd === "sync") {
    try {
      const pf = await syncFromGateway();
      console.log(`SYNCED ${pf.positions.length} positions · net liquidation ${usd(pf.netLiquidation)} · cash ${usd(pf.cash)} · invested ${usd(pf.grossPositionValue)} → trader/portfolio.json`);
      for (const h of holdings(pf).slice(0, 5)) console.log(`  ${h.ticker.padEnd(6)} ${(h.weight * 100).toFixed(1).padStart(5)}%  ${usd(h.marketValue).padStart(10)}  ${h.pnlPct >= 0 ? "+" : ""}${(h.pnlPct * 100).toFixed(1)}%`);
      return 0;
    } catch (e) {
      const code = e instanceof GatewayError ? e.code : "error";
      console.error(`${code === "login" ? "LOGIN NEEDED" : code === "down" ? "DOWN" : "ERROR"}: ${e instanceof Error ? e.message : String(e)}`);
      return code === "login" ? 3 : code === "down" ? 2 : 1;
    }
  }
  console.error("usage: npm run ibkr -- status | sync | where");
  return 1;
}

main().then((code) => process.exit(code));
