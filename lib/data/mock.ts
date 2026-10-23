// Offline synthetic data for development and demos: DODONA_MOCK=1 npm run dev
import type { Bar, Fundamentals, NewsItem, Quote, Snapshot } from "../types";

function seed(symbol: string) {
  let h = 2166136261;
  for (const c of symbol) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

export function mockSnapshot(symbol: string): Snapshot {
  const rnd = seed(symbol);
  const drift = (rnd() - 0.45) * 0.002;
  let p = 40 + rnd() * 260;
  const bars: Bar[] = [];
  const start = Date.now() - 300 * 86_400_000;
  for (let i = 0; i < 300; i++) {
    const d = new Date(start + i * 86_400_000);
    if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
    const o = p;
    p = p * (1 + drift + (rnd() - 0.5) * 0.03);
    bars.push({
      time: d.toISOString().slice(0, 10),
      open: o,
      high: Math.max(o, p) * (1 + rnd() * 0.01),
      low: Math.min(o, p) * (1 - rnd() * 0.01),
      close: p,
      volume: Math.round(2e6 + rnd() * 4e6),
    });
  }
  const prev = bars[bars.length - 2].close;
  const quote: Quote = {
    symbol,
    name: `${symbol} Mock Corp`,
    price: p,
    change: p - prev,
    changePct: p / prev - 1,
    currency: "USD",
    exchange: "MOCK",
    asOf: new Date().toISOString(),
    source: "yahoo",
  };
  const y = 0.01 + rnd() * 0.05;
  const fundamentals: Fundamentals = {
    marketCap: 5e9 + rnd() * 5e11,
    forwardPE: 8 + rnd() * 30,
    trailingPE: 10 + rnd() * 30,
    dividendYield: y,
    fiveYearAvgDividendYield: y * (0.7 + rnd() * 0.6),
    dividendRate: y * p,
    payoutRatio: 0.3 + rnd() * 0.7,
    revenueGrowth: (rnd() - 0.3) * 0.2,
    earningsGrowth: (rnd() - 0.3) * 0.3,
    debtToEquity: rnd() * 3,
    targetMeanPrice: p * (0.9 + rnd() * 0.35),
    numberOfAnalysts: Math.round(5 + rnd() * 20),
    recommendationKey: "buy",
    sector: "Mock Sector",
  };
  const news: NewsItem[] = [
    { title: `${symbol} reports quarterly results (synthetic)`, publisher: "Mock Wire", link: `https://example.com/${symbol}/1`, publishedAt: new Date().toISOString() },
  ];
  return { quote, bars, fundamentals, news, warnings: ["MOCK DATA — DODONA_MOCK=1 is set"] };
}
