import { NextResponse } from "next/server";
import { normalizeSymbol } from "@/lib/data";
import { loadOrCreateDesk, readDeskRules, withDeskLock, writeDesk } from "@/lib/data/desk";
import { runDesk } from "@/lib/data/deskRun";
import { deskView } from "@/lib/data/deskView";
import { PRACTICE_OFF, practiceOn } from "@/lib/data/practice";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// POST /api/desk/run {symbols?: string[], useAgent?: boolean}
// One desk cycle on the PAPER account: exits from real bars, a scan, Claude's (or the rules
// engine's) picks, sizing and the risk gate. Never touches a broker.
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { symbols?: unknown; useAgent?: unknown };
  const symbols: string[] = [];
  for (const raw of Array.isArray(body.symbols) ? body.symbols.slice(0, 30) : []) {
    try {
      symbols.push(normalizeSymbol(String(raw)));
    } catch {
      /* skip bad tickers */
    }
  }
  // the practice ledger only runs in paper mode: real-money mode spends nothing on fake trades
  if (!(await practiceOn())) return NextResponse.json({ error: PRACTICE_OFF }, { status: 409 });
  try {
    return await withDeskLock(async () => {
      const { rules, fromFile } = await readDeskRules();
      const s = await loadOrCreateDesk(rules);
      const report = await runDesk(s, rules, { symbols, useAgent: body.useAgent !== false });
      await writeDesk(s);
      return NextResponse.json({ report, desk: deskView(s, rules, fromFile) }, { headers: { "Cache-Control": "no-store" } });
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
