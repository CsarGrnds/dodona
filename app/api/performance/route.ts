import { NextResponse } from "next/server";
import { accountPerformance, GatewayError } from "@/lib/data/ibkr";
import { isPeriod } from "@/lib/performance";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// GET /api/performance?period=1M → daily account value (NAV) and time-weighted return from IBKR
// (Portfolio Analyst, through the local Client Portal Gateway). Read-only.
export async function GET(req: Request) {
  const period = new URL(req.url).searchParams.get("period") ?? "1M";
  if (!isPeriod(period)) return NextResponse.json({ error: `Unknown period ${period}` }, { status: 400 });
  try {
    return NextResponse.json({ performance: await accountPerformance(period) }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    const code = e instanceof GatewayError ? e.code : "error";
    return NextResponse.json({ state: code, error: e instanceof Error ? e.message : String(e) }, { status: code === "error" ? 500 : 503 });
  }
}
