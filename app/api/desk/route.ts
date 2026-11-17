import { NextResponse } from "next/server";
import { loadOrCreateDesk, readDeskRules } from "@/lib/data/desk";
import { deskView } from "@/lib/data/deskView";

export const dynamic = "force-dynamic";

// GET /api/desk — the paper desk: account, open positions, trades, journal, daily P&L history.
export async function GET() {
  try {
    const { rules, fromFile } = await readDeskRules();
    const s = await loadOrCreateDesk(rules);
    return NextResponse.json(deskView(s, rules, fromFile), { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
