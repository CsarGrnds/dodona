import { NextResponse } from "next/server";
import { liveRun, startLiveRun, stopLiveRun } from "@/lib/data/liveRun";
import { fromDodonaPage, localOnly } from "@/lib/data/localOnly";

export const dynamic = "force-dynamic";

// GET /api/desk/prepare — the trade team's live morning run: running?, its latest steps, its answer.
// POST {action:"start", mode:"live"|"paper"} / {action:"stop"} — start /trade-desk live (prepares the IBKR
// batch; it can't place orders) or /trade-desk (one paper cycle) in a background Claude Code session, or stop it. Only from a click in Dodona's page.
export async function GET(req: Request) {
  const denied = localOnly(req);
  if (denied) return denied;
  return NextResponse.json(await liveRun(), { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request) {
  const denied = fromDodonaPage(req);
  if (denied) return denied;
  const body = (await req.json().catch(() => null)) as { action?: string; mode?: string } | null;
  if (body?.action === "start") return NextResponse.json(await startLiveRun(body.mode === "paper" ? "paper" : "live"));
  if (body?.action === "stop") return NextResponse.json({ ok: await stopLiveRun() });
  return NextResponse.json({ ok: false, error: "action: start or stop" }, { status: 400 });
}
