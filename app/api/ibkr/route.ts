import { NextResponse } from "next/server";
import { gatewayStatus, GatewayError, syncFromGateway } from "@/lib/data/ibkr";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// GET  /api/ibkr → is the IBKR Client Portal Gateway running and logged in?
// POST /api/ibkr → read positions + summary from it (read-only) and write trader/portfolio.json.
export async function GET() {
  try {
    return NextResponse.json(await gatewayStatus(), { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ state: "down", message: e instanceof Error ? e.message : String(e) });
  }
}

export async function POST(req: Request) {
  // Only this app's own pages may trigger a sync (a sync writes a file on this machine).
  const origin = req.headers.get("origin");
  if (origin && new URL(origin).host !== req.headers.get("host")) return NextResponse.json({ error: "Cross-origin sync refused" }, { status: 403 });
  try {
    const portfolio = await syncFromGateway();
    return NextResponse.json({ portfolio });
  } catch (e) {
    const code = e instanceof GatewayError ? e.code : "error";
    return NextResponse.json({ state: code, error: e instanceof Error ? e.message : String(e) }, { status: code === "error" ? 500 : 503 });
  }
}
