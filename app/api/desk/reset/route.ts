import { copyFile } from "node:fs/promises";
import { NextResponse } from "next/server";
import { newDesk } from "@/lib/desk";
import { deskPath, readDesk, readDeskRules, withDeskLock, writeDesk } from "@/lib/data/desk";
import { deskView } from "@/lib/data/deskView";

export const dynamic = "force-dynamic";

// POST /api/desk/reset {confirm: true}
// Starts a fresh paper account at the budget in trader/config.json. The old ledger is kept as
// trader/desk-<timestamp>.json, so no history is lost.
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { confirm?: unknown };
  if (body.confirm !== true) return NextResponse.json({ error: "Send {confirm: true} to reset the paper account." }, { status: 400 });
  return withDeskLock(async () => {
    const { rules, fromFile } = await readDeskRules();
    let backup: string | undefined;
    if (await readDesk()) {
      backup = deskPath().replace(/\.json$/, `-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
      await copyFile(deskPath(), backup);
    }
    const s = newDesk(rules.budget, new Date().toISOString());
    await writeDesk(s);
    return NextResponse.json({ backup, desk: deskView(s, rules, fromFile) });
  });
}
