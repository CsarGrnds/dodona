import YahooFinance from "yahoo-finance2";
import type { Bar, Fundamentals, NewsItem, Quote } from "../types";

// One shared client. Notices (e.g. "yahooSurvey") are suppressed to keep logs clean.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const yf: any = new (YahooFinance as any)({ suppressNotices: ["yahooSurvey"] });

const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

const isoDate = (d: unknown): string | undefined => {
  if (!d) return undefined;
  const date = d instanceof Date ? d : new Date(d as string | number);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString().slice(0, 10);
};

export async function yahooQuote(symbol: string): Promise<Quote> {
  const q = await yf.quote(symbol);
  if (!q || num(q.regularMarketPrice) === undefined) throw new Error(`No Yahoo quote for ${symbol}`);
  return {
    symbol: q.symbol ?? symbol,
    name: q.longName ?? q.shortName ?? symbol,
    price: q.regularMarketPrice,
    change: num(q.regularMarketChange) ?? 0,
    changePct: (num(q.regularMarketChangePercent) ?? 0) / 100,
    currency: q.currency ?? "USD",
    exchange: q.fullExchangeName ?? q.exchange,
    marketState: q.marketState,
    asOf: (q.regularMarketTime instanceof Date ? q.regularMarketTime : new Date()).toISOString(),
    source: "yahoo",
  };
}

/** Daily bars. ~400 calendar days by default so a 200-day SMA is available. */
export async function yahooBars(symbol: string, days = 420): Promise<Bar[]> {
  const period1 = new Date(Date.now() - days * 86_400_000);
  const res = await yf.chart(symbol, { period1, interval: "1d" });
  const quotes: Array<Record<string, unknown>> = res?.quotes ?? [];
  return quotes
    .filter((r) => num(r.close) !== undefined)
    .map((r) => ({
      time: isoDate(r.date)!,
      open: num(r.open) ?? (r.close as number),
      high: num(r.high) ?? (r.close as number),
      low: num(r.low) ?? (r.close as number),
      close: r.close as number,
      volume: num(r.volume) ?? 0,
    }));
}

export async function yahooFundamentals(symbol: string): Promise<Fundamentals> {
  const s = await yf.quoteSummary(symbol, {
    modules: ["summaryDetail", "financialData", "defaultKeyStatistics", "assetProfile"],
  });
  const sd = s?.summaryDetail ?? {};
  const fd = s?.financialData ?? {};
  const ks = s?.defaultKeyStatistics ?? {};
  const ap = s?.assetProfile ?? {};
  // Yahoo reports fiveYearAvgDividendYield and debtToEquity as percentages (e.g. 2.4, 150).
  const fiveY = num(sd.fiveYearAvgDividendYield);
  const de = num(fd.debtToEquity);
  return {
    marketCap: num(sd.marketCap),
    trailingPE: num(sd.trailingPE),
    forwardPE: num(sd.forwardPE) ?? num(ks.forwardPE),
    pegRatio: num(ks.pegRatio),
    priceToBook: num(ks.priceToBook),
    dividendYield: num(sd.dividendYield) ?? num(sd.trailingAnnualDividendYield),
    dividendRate: num(sd.dividendRate) ?? num(sd.trailingAnnualDividendRate),
    fiveYearAvgDividendYield: fiveY !== undefined ? fiveY / 100 : undefined,
    payoutRatio: num(sd.payoutRatio),
    exDividendDate: isoDate(sd.exDividendDate),
    revenueGrowth: num(fd.revenueGrowth),
    earningsGrowth: num(fd.earningsGrowth),
    profitMargin: num(fd.profitMargins),
    debtToEquity: de !== undefined ? de / 100 : undefined,
    freeCashflow: num(fd.freeCashflow),
    beta: num(sd.beta),
    fiftyTwoWeekHigh: num(sd.fiftyTwoWeekHigh),
    fiftyTwoWeekLow: num(sd.fiftyTwoWeekLow),
    targetMeanPrice: num(fd.targetMeanPrice),
    recommendationKey: fd.recommendationKey,
    numberOfAnalysts: num(fd.numberOfAnalystOpinions),
    sector: ap.sector,
    industry: ap.industry,
  };
}

export async function yahooNews(symbol: string, count = 8): Promise<NewsItem[]> {
  const res = await yf.search(symbol, { newsCount: count, quotesCount: 0 });
  const news: Array<Record<string, unknown>> = res?.news ?? [];
  return news.map((n) => ({
    title: String(n.title ?? ""),
    publisher: n.publisher as string | undefined,
    link: String(n.link ?? ""),
    publishedAt: n.providerPublishTime
      ? new Date(n.providerPublishTime as string | number | Date).toISOString()
      : undefined,
  }));
}

export async function yahooSearch(query: string) {
  const res = await yf.search(query, { newsCount: 0, quotesCount: 8 });
  const quotes: Array<Record<string, unknown>> = res?.quotes ?? [];
  return quotes
    .filter((q) => q.symbol && (q.quoteType === "EQUITY" || q.quoteType === "ETF"))
    .map((q) => ({
      symbol: String(q.symbol),
      name: String(q.longname ?? q.shortname ?? q.symbol),
      exchange: q.exchDisp as string | undefined,
      type: q.quoteType as string,
    }));
}
