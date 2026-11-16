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

export interface GoogleParsed {
  name: string;
  price: number;
  prevClose?: number;
  change?: number;
  changePct?: number; // fraction
  currency: string;
}

const esc = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Reads the quote from a Google Finance page. Google embeds it as data (2026 markup):
 *   ["AAPL","NASDAQ"],"Apple Inc",0,"USD",[356.27,1.39,0.39,2,2,2],null,354.88
 *   = [ticker, exchange], name, type, currency, [price, change, change %, …], null, previous close
 * The older data-last-price attribute is kept as a fallback.
 */
export function parseGoogleQuote(html: string, ticker: string, exchange: string): GoogleParsed | null {
  const re = new RegExp(`\\["${esc(ticker)}","${esc(exchange)}"\\],"((?:[^"\\\\]|\\\\.)*)",\\d+,"([A-Z]{3})",\\[(-?[\\d.]+),(-?[\\d.]+),(-?[\\d.]+)[^\\]]*\\],null,(-?[\\d.]+)`);
  const m = re.exec(html);
  if (m) {
    let name = m[1];
    try {
      name = JSON.parse(`"${m[1]}"`);
    } catch {
      /* keep raw */
    }
    const price = parseFloat(m[3]);
    if (Number.isFinite(price) && price > 0) {
      return { name, currency: m[2], price, change: parseFloat(m[4]), changePct: parseFloat(m[5]) / 100, prevClose: parseFloat(m[6]) };
    }
  }
  const last = html.match(/data-last-price="([\d.]+)"/);
  if (!last) return null;
  const prev = html.match(/Previous close<\/div>[\s\S]{0,200}?\$?([\d,]+\.\d+)/);
  const name = html.match(/<div class="zzDege">([^<]+)<\/div>/);
  const currency = html.match(/data-currency-code="([A-Z]{3})"/);
  const price = parseFloat(last[1]);
  const pc = prev ? parseFloat(prev[1].replace(/,/g, "")) : undefined;
  return { name: name?.[1] ?? ticker, price, prevClose: pc, change: pc ? price - pc : undefined, changePct: pc ? (price - pc) / pc : undefined, currency: currency?.[1] ?? "USD" };
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
      const q = parseGoogleQuote(await res.text(), ticker, ex);
      if (!q) continue;
      return {
        symbol: symbol.toUpperCase(),
        name: q.name,
        price: q.price,
        change: q.change ?? 0,
        changePct: q.changePct ?? 0,
        currency: q.currency,
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
