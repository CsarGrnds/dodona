import { cached } from "../cache";
import type { IntradayBar } from "../setups";
import type { Bar, Fundamentals, NewsItem, Quote, Snapshot } from "../types";
import { googleQuote } from "./google";
import { mockIntraday, mockSnapshot } from "./mock";
import { yahooBars, yahooFundamentals, yahooIntraday, yahooNews, yahooQuote, yahooSearch } from "./yahoo";

const MIN = 60_000;
const MOCK = process.env.DODONA_MOCK === "1";

export function normalizeSymbol(raw: string): string {
  const s = decodeURIComponent(raw).trim().toUpperCase();
  if (!/^[A-Z0-9.\-^=]{1,15}$/.test(s)) throw new Error(`Invalid ticker: ${raw}`);
  return s;
}

/** Live quote: Yahoo first, Google Finance page as fallback. */
export async function getQuote(symbol: string): Promise<Quote> {
  if (MOCK) return mockSnapshot(symbol).quote;
  return cached(`quote:${symbol}`, 1 * MIN, async () => {
    try {
      return await yahooQuote(symbol);
    } catch (yErr) {
      const g = await googleQuote(symbol);
      if (g) return g;
      throw yErr;
    }
  });
}

/** Everything the agent needs for one ticker. Partial failures become warnings, not errors. */
export async function getSnapshot(symbol: string): Promise<Snapshot> {
  if (MOCK) return mockSnapshot(symbol);
  const warnings: string[] = [];
  const [quote, bars, fundamentals, news] = await Promise.all([
    getQuote(symbol),
    cached(`bars:${symbol}`, 15 * MIN, () => yahooBars(symbol)).catch((e) => {
      warnings.push(`Price history unavailable: ${e.message}`);
      return [];
    }),
    cached(`fund:${symbol}`, 6 * 60 * MIN, () => yahooFundamentals(symbol)).catch((e): Fundamentals => {
      warnings.push(`Fundamentals unavailable: ${e.message}`);
      return {};
    }),
    cached(`news:${symbol}`, 10 * MIN, () => yahooNews(symbol)).catch((e): NewsItem[] => {
      warnings.push(`News unavailable: ${e.message}`);
      return [];
    }),
  ]);
  if (quote.source === "google") warnings.push("Live price from Google Finance fallback (Yahoo quote failed).");
  return { quote, bars, fundamentals, news, warnings };
}

export async function searchSymbols(query: string) {
  if (MOCK) return [{ symbol: query.toUpperCase(), name: `${query.toUpperCase()} Mock Corp`, exchange: "MOCK", type: "EQUITY" }];
  return cached(`search:${query.toLowerCase()}`, 60 * MIN, () => yahooSearch(query));
}

/** ~3 years of daily bars for track records. */
export async function getDailyHistory(symbol: string): Promise<Bar[]> {
  if (MOCK) return mockSnapshot(symbol).bars;
  return cached(`hist:${symbol}`, 60 * MIN, () => yahooBars(symbol, 1100));
}

/** Last ~59 days of 5-minute bars (raw; split into sessions with lib/setups.ts). */
export async function getIntraday(symbol: string): Promise<IntradayBar[]> {
  if (MOCK) return mockIntraday(symbol);
  return cached(`5m:${symbol}`, 2 * MIN, () => yahooIntraday(symbol));
}
