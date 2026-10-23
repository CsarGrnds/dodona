export type Strategy = "dividend" | "swing";
export type Action = "BUY" | "SELL" | "HOLD";

export interface Bar {
  time: string; // YYYY-MM-DD
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Quote {
  symbol: string;
  name: string;
  price: number;
  change: number;
  changePct: number;
  currency: string;
  exchange?: string;
  marketState?: string;
  asOf: string; // ISO
  source: "yahoo" | "google";
}

export interface Fundamentals {
  marketCap?: number;
  trailingPE?: number;
  forwardPE?: number;
  pegRatio?: number;
  priceToBook?: number;
  dividendYield?: number; // fraction, e.g. 0.031
  dividendRate?: number;
  fiveYearAvgDividendYield?: number; // fraction
  payoutRatio?: number; // fraction
  exDividendDate?: string;
  revenueGrowth?: number; // fraction
  earningsGrowth?: number; // fraction
  profitMargin?: number;
  debtToEquity?: number;
  freeCashflow?: number;
  beta?: number;
  fiftyTwoWeekHigh?: number;
  fiftyTwoWeekLow?: number;
  targetMeanPrice?: number;
  recommendationKey?: string; // analyst consensus
  numberOfAnalysts?: number;
  sector?: string;
  industry?: string;
}

export interface NewsItem {
  title: string;
  publisher?: string;
  link: string;
  publishedAt?: string;
}

export interface Snapshot {
  quote: Quote;
  bars: Bar[];
  fundamentals: Fundamentals;
  news: NewsItem[];
  warnings: string[];
}

export interface Indicators {
  sma20?: number;
  sma50?: number;
  sma200?: number;
  ema12?: number;
  ema26?: number;
  rsi14?: number;
  macd?: number;
  macdSignal?: number;
  macdHist?: number;
  macdHistPrev?: number;
  bbUpper?: number;
  bbLower?: number;
  atr14?: number;
  high52w?: number;
  low52w?: number;
  drawdownFromHigh?: number; // fraction, negative
  return1m?: number;
  return3m?: number;
  return1y?: number;
  volumeRatio?: number; // today vs 20d avg
  goldenCross?: boolean; // sma50 crossed above sma200 in last 10 sessions
  deathCross?: boolean;
}

export interface Factor {
  name: string;
  score: number; // -2..+2 contribution
  detail: string;
}

export interface RuleSignal {
  strategy: Strategy;
  action: Action;
  score: number; // -100..100
  confidence: number; // 0..1
  factors: Factor[];
  levels: { buyBelow?: number; trimAbove?: number; stopLoss?: number; takeProfit?: number };
}

export interface AgentView {
  action: Action;
  confidence: number;
  thesis: string;
  risks: string[];
  watchFor: string[];
  model: string;
}

export interface Analysis {
  symbol: string;
  strategy: Strategy;
  generatedAt: string;
  quote: Quote;
  indicators: Indicators;
  fundamentals: Fundamentals;
  rules: RuleSignal;
  agent?: AgentView;
  agentError?: string;
  final: { action: Action; confidence: number; source: "agent" | "rules" };
  news: NewsItem[];
  bars: Bar[];
  warnings: string[];
}
