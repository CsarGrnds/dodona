// Shape of GET /api/today (the Today page's daily prep), plus the one-line to-do list built from
// it. Pure and shared.
import type { MarketStatus } from "./clock";
import type { Level } from "./levels";
import type { MarketContext } from "./market";
import type { DipCheck, LimitCheck, OpenOrder, StopAdvice, StopSuggestion, TradingRules, Trend } from "./prep";
import type { SwingSetup } from "./setups";

export interface PrepRow {
  symbol: string;
  source: { held: boolean; buyLimit: boolean; watch: boolean };
  error?: string;
  name?: string;
  price?: number;
  changePct?: number;
  atr?: number;
  rsi?: number;
  sma50?: number;
  sma200?: number;
  trend?: Trend;
  supports?: Level[];
  resistances?: Level[];
  setups?: SwingSetup[];
  position?: { shares: number; avgCost: number };
  orders?: OpenOrder[];
  suggestion?: StopSuggestion;
  stop?: StopAdvice;
  dip?: DipCheck;
  limits?: Array<{ order: OpenOrder; check: LimitCheck }>;
  earningsInDays?: number;
  nextEarnings?: string;
  warnings?: string[];
}

export interface TodayResult {
  asOf: string;
  clock: MarketStatus;
  market?: MarketContext;
  portfolio: { syncedAt: string; netLiquidation: number; cash: number; currency: string } | null;
  orders: { state: "ready" | "login" | "down" | "error"; url: string; count: number; other: OpenOrder[] };
  rules: TradingRules;
  rows: PrepRow[];
  warnings: string[];
}

export interface Todo {
  symbol: string;
  kind: "stop" | "earnings" | "discount" | "limit";
  urgency: 0 | 1 | 2; // 0 = do first
  text: string;
}

/** The short list of things to act on before the bell, most urgent first. */
export function todoList(rows: PrepRow[]): Todo[] {
  const out: Todo[] = [];
  for (const r of rows) {
    if (r.stop) {
      const v = r.stop.verdict;
      if (v === "missing" || v === "above" || v === "below-cost") out.push({ symbol: r.symbol, kind: "stop", urgency: 0, text: r.stop.headline });
      else if (v === "raise" || v === "partial") out.push({ symbol: r.symbol, kind: "stop", urgency: 1, text: r.stop.headline });
      else if (v === "tight") out.push({ symbol: r.symbol, kind: "stop", urgency: 2, text: r.stop.headline });
    }
    if (r.earningsInDays !== undefined && (r.source.held || r.limits?.length)) {
      out.push({
        symbol: r.symbol,
        kind: "earnings",
        urgency: r.earningsInDays <= 2 ? 0 : 1,
        text: `Earnings ${r.earningsInDays === 0 ? "today" : `in ${r.earningsInDays} trading day${r.earningsInDays === 1 ? "" : "s"}`} (${r.nextEarnings}): a stop can't stop a gap`,
      });
    }
    if (r.dip?.verdict === "discount") out.push({ symbol: r.symbol, kind: "discount", urgency: 2, text: `${r.dip.headline}${r.dip.support ? ` · support $${r.dip.support.price.toFixed(2)}` : ""}` });
    for (const l of r.limits ?? []) {
      if (l.check.verdict === "fills") out.push({ symbol: r.symbol, kind: "limit", urgency: 0, text: `Buy limit $${l.order.limit!.toFixed(2)} is at/above the price: likely fills at the open` });
      else if (r.trend === "down") out.push({ symbol: r.symbol, kind: "limit", urgency: 1, text: `Buy limit $${l.order.limit!.toFixed(2)} in a downtrend: still want it?` });
    }
  }
  return out.sort((a, b) => a.urgency - b.urgency);
}
