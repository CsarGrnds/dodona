import { NextResponse } from "next/server";
import { getQuote, normalizeSymbol } from "@/lib/data";

export const dynamic = "force-dynamic";

// GET /api/quote?symbols=AAPL,MSFT
export async function GET(req: Request) {
  const raw = new URL(req.url).searchParams.get("symbols") ?? "";
  const symbols = raw.split(",").filter(Boolean).slice(0, 40);
  const results = await Promise.all(
    symbols.map(async (s) => {
      try {
        return { ok: true as const, quote: await getQuote(normalizeSymbol(s)) };
      } catch (e) {
        return { ok: false as const, symbol: s, error: e instanceof Error ? e.message : String(e) };
      }
    }),
  );
  return NextResponse.json({ results });
}
