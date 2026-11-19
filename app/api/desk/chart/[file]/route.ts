import { NextResponse } from "next/server";
import { readChart } from "@/lib/data/analysis";
import { localOnly } from "@/lib/data/localOnly";

export const dynamic = "force-dynamic";

// GET /api/desk/chart/SYM-YYYY-MM-DD-HHMM.png — a chart the trade-chartist drew (trader/charts). Local only.
export async function GET(req: Request, { params }: { params: Promise<{ file: string }> }) {
  const denied = localOnly(req);
  if (denied) return denied;
  const png = await readChart((await params).file);
  if (!png) return NextResponse.json({ error: "No such chart." }, { status: 404 });
  return new NextResponse(new Uint8Array(png), { headers: { "Content-Type": "image/png", "Cache-Control": "private, max-age=3600" } });
}
