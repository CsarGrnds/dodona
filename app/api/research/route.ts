import { NextResponse } from "next/server";
import { normalizeSymbol } from "@/lib/data";
import { cikFor, earningsReport, recentFilings, secUserAgent } from "@/lib/data/sec";
import type { ResearchResult } from "@/lib/news";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// GET /api/research?symbol=TSLA → SEC EDGAR filings (8-K items labeled, like /trader-news) and
// reported quarters from XBRL company facts (like /trader-analyst).
export async function GET(req: Request) {
  let symbol: string;
  try {
    symbol = normalizeSymbol(new URL(req.url).searchParams.get("symbol") ?? "");
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
  const out: ResearchResult = { symbol, sec: "ok", filings: [], earnings: null, warnings: [] };
  const ua = await secUserAgent();
  if (!ua) {
    out.sec = "no-user-agent";
    return NextResponse.json(out);
  }
  try {
    const cik = await cikFor(symbol, ua);
    if (!cik) {
      out.sec = "not-found";
      out.warnings.push(`${symbol} is not in SEC's ticker list (ETFs and most foreign listings file differently).`);
      return NextResponse.json(out);
    }
    // sequential on purpose: SEC asks for no more than 10 requests a second
    out.filings = await recentFilings(cik, ua).catch((e) => {
      out.warnings.push(`SEC filings unavailable: ${e.message}`);
      return [];
    });
    out.earnings = await earningsReport(cik, ua).catch((e) => {
      out.warnings.push(`SEC XBRL facts unavailable: ${e.message}`);
      return null;
    });
  } catch (e) {
    out.sec = "error";
    out.warnings.push(`SEC EDGAR unavailable: ${e instanceof Error ? e.message : String(e)}`);
  }
  return NextResponse.json(out, { headers: { "Cache-Control": "no-store" } });
}
