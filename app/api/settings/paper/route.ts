import { NextResponse } from "next/server";
import { fromDodonaPage } from "@/lib/data/localOnly";
import { setPaperMode } from "@/lib/data/practice";

export const dynamic = "force-dynamic";

// POST /api/settings/paper {paper: boolean, typed?: string} — the paper-mode switch in Settings.
// Only from a click on Dodona's own page; turning paper off (real money) needs "REAL MONEY" typed.
export async function POST(req: Request) {
  const denied = fromDodonaPage(req);
  if (denied) return denied;
  const b = (await req.json().catch(() => null)) as { paper?: unknown; typed?: unknown } | null;
  if (typeof b?.paper !== "boolean") return NextResponse.json({ ok: false, error: "paper: true or false" }, { status: 400 });
  const r = await setPaperMode(b.paper, String(b.typed ?? ""));
  return NextResponse.json(r, { status: r.ok ? 200 : 422 });
}
