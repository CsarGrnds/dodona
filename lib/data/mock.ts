// Offline synthetic data for development and demos: DODONA_MOCK=1 npm run dev
import { nyClock, OPEN_MIN, type IntradayBar } from "../setups";
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

/** Synthetic 5-minute bars: the last 60 weekdays, 78 regular-hours bars each, around the mock price. */
export function mockIntraday(symbol: string, nowMs = Date.now()): IntradayBar[] {
  const rnd = seed(`${symbol}:5m`);
  let p = mockSnapshot(symbol).quote.price;
  const out: IntradayBar[] = [];
  const days: number[] = [];
  for (let d = 1; days.length < 60 && d < 120; d++) {
    const day = new Date(nowMs - d * 86_400_000);
    const wd = day.getUTCDay();
    if (wd !== 0 && wd !== 6) days.unshift(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()));
  }
  for (const dayUtc of days) {
    // 9:30 New York is 13:30 or 14:30 UTC depending on daylight saving time.
    const open = [13.5, 14.5].map((h) => dayUtc + h * 3_600_000).find((t) => nyClock(t).minute === OPEN_MIN)!;
    const trend = (rnd() - 0.5) * 0.004;
    for (let k = 0; k < 78; k++) {
      const o = p;
      p = p * (1 + trend + (rnd() - 0.5) * (k < 6 ? 0.008 : 0.004));
      out.push({ t: open + k * 300_000, open: o, high: Math.max(o, p) * (1 + rnd() * 0.0015), low: Math.min(o, p) * (1 - rnd() * 0.0015), close: p, volume: Math.round(5e4 + rnd() * 2e5) });
    }
  }
  return out;
}
