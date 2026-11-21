import { NextResponse } from "next/server";
import { getDailyHistory, normalizeSymbol } from "@/lib/data";

export const dynamic = "force-dynamic";

// GET /api/bars?symbol=KO&days=120 — the last daily bars for a small chart (the stop ticket's). Read-only.
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const days = Math.min(Math.max(Number(q.get("days")) || 120, 20), 400);
  try {
    const bars = await getDailyHistory(normalizeSymbol(q.get("symbol") ?? ""));
    return NextResponse.json({ bars: bars.slice(-days) });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
