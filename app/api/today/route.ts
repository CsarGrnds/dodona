import { NextResponse } from "next/server";
import { getMarketBars, getSnapshot, normalizeSymbol } from "@/lib/data";
import { gatewayStatus, openOrders } from "@/lib/data/ibkr";
import { readPortfolio } from "@/lib/data/portfolio";
import { marketStatus, tradingDaysBetween } from "@/lib/clock";
import { computeIndicators } from "@/lib/indicators";
import { supportResistance } from "@/lib/levels";
import { marketAt, marketSeries } from "@/lib/market";
import { adviseStop, DEFAULT_RULES, dipCheck, earningsSoon, limitCheck, suggestStop, trendOf, type OpenOrder, type TradingRules } from "@/lib/prep";
import { findSwingSetups } from "@/lib/setups";
import type { PrepRow, TodayResult } from "@/lib/today";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const PARALLEL = 4;
const MAX_EXTRA = 30;

// GET /api/today[?symbols=AAPL,KO&noLoss=1]
// The day's prep for the synced IBKR holdings, the tickers with resting buy limits, and any extra
// symbols (the watchlist): suggested stops vs the stop orders at IBKR, discounts, buy limits.
// Read-only: orders are read from the local IBKR gateway, never placed or changed.
export async function GET(req: Request) {
  const now = Date.now();
  const warnings: string[] = [];
  const extra: string[] = [];
  const params = new URL(req.url).searchParams;
  const rules: TradingRules = { neverSellAtLoss: params.has("noLoss") ? params.get("noLoss") === "1" : DEFAULT_RULES.neverSellAtLoss };
  for (const s of (params.get("symbols") ?? "").split(",").filter(Boolean).slice(0, MAX_EXTRA)) {
    try {
      extra.push(normalizeSymbol(s));
    } catch {
      warnings.push(`Skipped invalid ticker ${s}`);
    }
  }

  const [portfolio, gw, spy] = await Promise.all([
    readPortfolio().catch((e) => {
      warnings.push(`Portfolio unreadable: ${e.message}`);
      return null;
    }),
    gatewayStatus(),
    getMarketBars().catch(() => []),
  ]);
  let orders: OpenOrder[] = [];
  let ordersState: TodayResult["orders"]["state"] = gw.state;
  if (gw.state === "ready") {
    try {
      orders = await openOrders();
    } catch (e) {
      ordersState = "error";
      warnings.push(`Open orders unavailable: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const held = new Map((portfolio?.positions ?? []).filter((p) => p.assetClass === "STK" && p.shares > 0).map((p) => [p.ticker, p]));
  const buyLimitTickers = orders.filter((o) => o.side === "BUY" && o.limit !== undefined).map((o) => o.ticker);
  const symbols = [...new Set([...held.keys(), ...buyLimitTickers, ...extra])];
  const clock = marketStatus(now);
  const ms = spy.length ? marketSeries(spy) : undefined;

  const rows: PrepRow[] = [];
  const queue = [...symbols];
  const worker = async () => {
    for (let sym = queue.shift(); sym; sym = queue.shift()) {
      try {
        rows.push(await prepFor(sym, held.get(sym), orders, clock.date, rules));
      } catch (e) {
        rows.push({ symbol: sym, error: e instanceof Error ? e.message : String(e), source: sources(sym, held, buyLimitTickers, extra) });
      }
    }
  };
  await Promise.all(Array.from({ length: PARALLEL }, worker));
  for (const r of rows) r.source = sources(r.symbol, held, buyLimitTickers, extra);
  const order = new Map(symbols.map((s, i) => [s, i]));
  rows.sort((a, b) => order.get(a.symbol)! - order.get(b.symbol)!);

  const result: TodayResult = {
    asOf: new Date(now).toISOString(),
    clock,
    market: ms ? marketAt(ms) : undefined,
    portfolio: portfolio ? { syncedAt: portfolio.syncedAt, netLiquidation: portfolio.netLiquidation, cash: portfolio.cash, currency: portfolio.currency } : null,
    orders: { state: ordersState, url: gw.url, count: orders.length, other: orders.filter((o) => o.side === "SELL" && o.stop === undefined) },
    rules,
    rows,
    warnings,
  };
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
}

function sources(sym: string, held: Map<string, unknown>, limits: string[], extra: string[]): PrepRow["source"] {
  return { held: held.has(sym), buyLimit: limits.includes(sym), watch: extra.includes(sym) };
}

async function prepFor(symbol: string, pos: { shares: number; avgCost: number } | undefined, orders: OpenOrder[], today: string, rules: TradingRules): Promise<PrepRow> {
  const snap = await getSnapshot(symbol);
  const price = snap.quote.price;
  const ind = computeIndicators(snap.bars, price);
  const levels = snap.bars.length > 20 ? supportResistance(snap.bars, price, ind.atr14) : undefined;
  const setups = findSwingSetups(snap.bars.map((b) => b.close))?.tags ?? [];
  const mine = orders.filter((o) => o.ticker === symbol);
  const trend = trendOf(price, ind);
  const suggestion = suggestStop(snap.bars, price, ind, levels, pos?.avgCost) ?? undefined;
  const row: PrepRow = {
    symbol,
    source: { held: !!pos, buyLimit: false, watch: false }, // set by the caller
    name: snap.quote.name,
    price,
    changePct: snap.quote.changePct,
    atr: ind.atr14,
    rsi: ind.rsi14,
    sma50: ind.sma50,
    sma200: ind.sma200,
    trend,
    supports: levels?.supports.slice(0, 2),
    resistances: levels?.resistances.slice(0, 2),
    setups,
    position: pos ? { shares: pos.shares, avgCost: pos.avgCost } : undefined,
    orders: mine,
    suggestion,
    dip: dipCheck(price, ind, levels, setups, pos?.avgCost),
    earningsInDays: earningsSoon(snap.fundamentals.nextEarningsDate, today, tradingDaysBetween),
    nextEarnings: snap.fundamentals.nextEarningsDate,
    warnings: snap.warnings,
  };
  if (pos && suggestion && ind.atr14) {
    row.stop = adviseStop({ ticker: symbol, shares: pos.shares, avgCost: pos.avgCost, price, atr: ind.atr14 }, suggestion, orders, rules);
  }
  row.limits = mine.filter((o) => o.side === "BUY" && o.limit !== undefined).map((o) => ({ order: o, check: limitCheck(o.limit!, price, ind.atr14, levels, trend) }));
  return row;
}
