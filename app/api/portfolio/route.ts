import { NextResponse } from "next/server";
import { readPortfolio } from "@/lib/data/portfolio";

export const dynamic = "force-dynamic";

// GET /api/portfolio → { portfolio: Portfolio | null }
// Filled by the dodona-sync skill (`npm run sync:ibkr`) from the Interactive Brokers connector.
export async function GET() {
  try {
    return NextResponse.json({ portfolio: await readPortfolio() }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
