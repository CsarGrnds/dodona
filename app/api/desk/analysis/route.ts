import { NextResponse } from "next/server";
import { readAnalysis } from "@/lib/data/analysis";
import { localOnly } from "@/lib/data/localOnly";

export const dynamic = "force-dynamic";

// GET /api/desk/analysis[?date=YYYY-MM-DD] — every stock the trade team analyzed that day, grouped by
// run, with its chart, the chartist's read, the verdict, the coach's replay and its IBKR ticket.
export async function GET(req: Request) {
  const denied = localOnly(req);
  if (denied) return denied;
  const date = new URL(req.url).searchParams.get("date") ?? undefined;
  return NextResponse.json(await readAnalysis(date), { headers: { "Cache-Control": "no-store" } });
}
