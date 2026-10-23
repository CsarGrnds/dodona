import { NextResponse } from "next/server";
import { searchSymbols } from "@/lib/data";

export const dynamic = "force-dynamic";

// GET /api/search?q=apple
export async function GET(req: Request) {
  const q = (new URL(req.url).searchParams.get("q") ?? "").trim();
  if (q.length < 1) return NextResponse.json({ results: [] });
  try {
    return NextResponse.json({ results: await searchSymbols(q) });
  } catch (e) {
    return NextResponse.json({ results: [], error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
