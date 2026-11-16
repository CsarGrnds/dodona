import { NextResponse } from "next/server";
import { getQuote, getSnapshot } from "@/lib/data";
import { readPortfolio } from "@/lib/data/portfolio";
import { marketStatus } from "@/lib/clock";
import { MARKET_SYMBOL } from "@/lib/market";
import { pulse, type PulseHolding } from "@/lib/pulse";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
const PARALLEL = 4;

// GET /api/pulse → today's winners and losers in the synced IBKR holdings, at live Yahoo prices,
// and a plain-language reading of why the portfolio is up or down (see lib/pulse.ts).
export async function GET() {
  const warnings: string[] = [];
  const pf = await readPortfolio().catch((e) => {
    warnings.push(`Portfolio unreadable: ${e.message}`);
    return null;
  });
  if (!pf) return NextResponse.json({ portfolio: null, warnings }, { headers: { "Cache-Control": "no-store" } });

  const spy = await getQuote(MARKET_SYMBOL).catch(() => undefined);
  if (!spy) warnings.push("SPY quote unavailable: no market attribution.");
  const queue = pf.positions.filter((p) => p.assetClass === "STK" && p.shares > 0);
  const holdings: PulseHolding[] = [];
  const worker = async () => {
    for (let p = queue.shift(); p; p = queue.shift()) {
      try {
        const s = await getSnapshot(p.ticker);
        const n = s.news[0];
        holdings.push({
          ticker: p.ticker,
          name: s.quote.name,
          shares: p.shares,
          avgCost: p.avgCost,
          price: s.quote.price,
          change: s.quote.change,
          changePct: s.quote.changePct,
          sector: s.fundamentals.sector,
          beta: s.fundamentals.beta,
          nextEarnings: s.fundamentals.nextEarningsDate,
          headline: n ? { title: n.title, link: n.link, publisher: n.publisher, publishedAt: n.publishedAt } : undefined,
        });
      } catch (e) {
        holdings.push({ ticker: p.ticker, shares: p.shares, avgCost: p.avgCost, price: 0, change: 0, changePct: 0, error: e instanceof Error ? e.message : String(e) });
      }
    }
  };
  await Promise.all(Array.from({ length: PARALLEL }, worker));
  const failed = holdings.filter((h) => h.error).map((h) => h.ticker);
  if (failed.length) warnings.push(`No live price for ${failed.join(", ")}: left out.`);

  return NextResponse.json(
    {
      asOf: new Date().toISOString(),
      clock: marketStatus(Date.now()),
      quoteTime: spy?.asOf,
      syncedAt: pf.syncedAt,
      currency: pf.currency,
      pulse: pulse(holdings, spy?.changePct),
      warnings,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
