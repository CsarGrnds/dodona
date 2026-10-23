import type { Quote } from "../types";

// Google Finance has no public API. This scrapes the public quote page as a
// price-only fallback when Yahoo fails. It is fragile by nature: if Google
// changes its markup, this returns null and Dodona reports Yahoo's error.

const EXCHANGES = ["NASDAQ", "NYSE", "NYSEARCA", "NYSEAMERICAN", "BATS"];

function toGoogleSymbol(symbol: string): { ticker: string; exchanges: string[] } {
  // Yahoo uses "BRK-B"; Google uses "BRK.B". Non-US suffixes (e.g. ".TO") are not mapped.
  const ticker = symbol.toUpperCase().replace("-", ".");
  return { ticker, exchanges: EXCHANGES };
}

export async function googleQuote(symbol: string): Promise<Quote | null> {
  const { ticker, exchanges } = toGoogleSymbol(symbol);
  for (const ex of exchanges) {
    try {
      const res = await fetch(`https://www.google.com/finance/quote/${ticker}:${ex}?hl=en`, {
        headers: { "User-Agent": "Mozilla/5.0 (Macintosh) Dodona/0.1", "Accept-Language": "en-US" },
        cache: "no-store",
      });
      if (!res.ok) continue;
      const html = await res.text();
      const price = html.match(/data-last-price="([\d.]+)"/);
      if (!price) continue;
      const prev = html.match(/Previous close<\/div>[\s\S]{0,200}?\$?([\d,]+\.\d+)/);
      const name = html.match(/<div class="zzDege">([^<]+)<\/div>/);
      const currency = html.match(/data-currency-code="([A-Z]{3})"/);
      const p = parseFloat(price[1]);
      const pc = prev ? parseFloat(prev[1].replace(/,/g, "")) : NaN;
      const change = Number.isFinite(pc) ? p - pc : 0;
      return {
        symbol: symbol.toUpperCase(),
        name: name?.[1] ?? symbol.toUpperCase(),
        price: p,
        change,
        changePct: Number.isFinite(pc) && pc ? change / pc : 0,
        currency: currency?.[1] ?? "USD",
        exchange: ex,
        asOf: new Date().toISOString(),
        source: "google",
      };
    } catch {
      // try next exchange
    }
  }
  return null;
}
