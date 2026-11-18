import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { configPath, loadOrCreateDesk, readDeskRules } from "@/lib/data/desk";
import { deskView } from "@/lib/data/deskView";

export const dynamic = "force-dynamic";

// GET /api/desk — the paper desk: account, open positions, trades, journal, daily P&L history.
export async function GET() {
  try {
    const { rules, fromFile } = await readDeskRules();
    const s = await loadOrCreateDesk(rules);
    // the practice ledger is always paper; real orders (if turned on) go to IBKR from the IBKR panel
    const cfg = await readFile(configPath(), "utf8").then(JSON.parse).catch(() => ({}) as Record<string, unknown>);
    const realOrders = { on: cfg.ibkr_orders === true && String(cfg.broker ?? "").toLowerCase() === "ibkr", live: cfg.paper === false };
    return NextResponse.json({ ...deskView(s, rules, fromFile), realOrders }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
