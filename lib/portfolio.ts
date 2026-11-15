// Portfolio model shared by the server, the browser and the sync script. Pure: no I/O.
//
// The file lives at trader/portfolio.json (gitignored). It is a superset of the format the
// day-trader skills already read and write ({cash, positions: [{ticker, shares, lots}]}), so
// /trader-budget, /trader-news and /trader-alerts see the same holdings Dodona does.
// It is filled from the Interactive Brokers connector by `npm run sync:ibkr` (see
// .claude/skills/dodona-sync/SKILL.md). Dodona never places orders.

export interface PortfolioLot {
  id: string;
  date: string; // YYYY-MM-DD the lot was recorded (IBKR gives an average cost, not lot dates)
  shares: number;
  cost: number; // total dollars
}

export interface Position {
  ticker: string;
  shares: number;
  avgCost: number;
  marketPrice: number;
  marketValue: number;
  unrealizedPnl: number;
  dailyPnl?: number;
  assetClass: string;
  conid?: number;
  lots: PortfolioLot[];
}

export interface Portfolio {
  source: "ibkr";
  syncedAt: string; // ISO
  currency: string;
  cash: number;
  netLiquidation: number;
  grossPositionValue: number;
  buyingPower?: number;
  positions: Position[];
}

const num = (v: unknown): number | undefined => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
};
const r2 = (v: number) => Math.round(v * 100) / 100;
const r6 = (v: number) => Math.round(v * 1e6) / 1e6;

/** IBKR connector output (get_account_positions + get_account_summary) → Portfolio. */
export function fromIbkr(positionsRaw: unknown, summaryRaw: unknown, now = new Date()): Portfolio {
  const pr = positionsRaw as { positions?: unknown[] } | unknown[];
  const list = Array.isArray(pr) ? pr : Array.isArray(pr?.positions) ? pr.positions : null;
  if (!list) throw new Error("IBKR positions: expected {positions: [...]}");
  const sm = (summaryRaw ?? {}) as Record<string, unknown>;
  const date = now.toISOString().slice(0, 10);

  const positions: Position[] = [];
  for (const item of list) {
    const p = item as Record<string, unknown>;
    const ticker = String(p.contract_description ?? p.ticker ?? "").trim().toUpperCase();
    const shares = num(p.position);
    if (!ticker || !shares) continue; // closed or malformed rows
    const avgCost = num(p.average_price) ?? 0;
    const marketPrice = num(p.market_price) ?? 0;
    positions.push({
      ticker,
      shares: r6(shares),
      avgCost: r6(avgCost),
      marketPrice: r6(marketPrice),
      marketValue: r2(num(p.market_value) ?? shares * marketPrice),
      unrealizedPnl: r2(num(p.unrealized_pnl) ?? shares * (marketPrice - avgCost)),
      dailyPnl: num(p.daily_pnl) !== undefined ? r2(num(p.daily_pnl)!) : undefined,
      assetClass: String(p.asset_class ?? "STK"),
      conid: num(p.contract_id),
      // One lot at IBKR's average cost, so the skills' sell logic has a cost basis to relieve.
      lots: [{ id: `${ticker}-ibkr`, date, shares: r6(shares), cost: r2(shares * avgCost) }],
    });
  }
  positions.sort((a, b) => b.marketValue - a.marketValue);

  const gross = num(sm.gross_position_value) ?? positions.reduce((s, p) => s + p.marketValue, 0);
  const cash = num(sm.total_cash_value) ?? num(sm.available_funds) ?? 0;
  return {
    source: "ibkr",
    syncedAt: now.toISOString(),
    currency: String(sm.currency ?? "USD"),
    cash: r2(cash),
    netLiquidation: r2(num(sm.net_liquidation) ?? gross + cash),
    grossPositionValue: r2(gross),
    buyingPower: num(sm.buying_power),
    positions,
  };
}

/** Light validation for a file read from disk (it may be hand-edited or written by the skills). */
export function parsePortfolio(raw: unknown): Portfolio | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.positions)) return null;
  const positions: Position[] = [];
  for (const it of o.positions) {
    const p = it as Record<string, unknown>;
    const ticker = String(p.ticker ?? p.symbol ?? "").toUpperCase();
    const shares = num(p.shares);
    if (!ticker || !shares) continue;
    const lots = Array.isArray(p.lots) ? (p.lots as PortfolioLot[]) : [];
    const lotCost = lots.reduce((s, l) => s + (num(l.cost) ?? 0), 0);
    const avgCost = num(p.avgCost) ?? (lotCost && shares ? lotCost / shares : 0);
    const marketPrice = num(p.marketPrice) ?? avgCost;
    positions.push({
      ticker,
      shares,
      avgCost,
      marketPrice,
      marketValue: num(p.marketValue) ?? shares * marketPrice,
      unrealizedPnl: num(p.unrealizedPnl) ?? shares * (marketPrice - avgCost),
      dailyPnl: num(p.dailyPnl),
      assetClass: String(p.assetClass ?? "STK"),
      conid: num(p.conid),
      lots,
    });
  }
  const cash = num(o.cash) ?? 0;
  const gross = num(o.grossPositionValue) ?? positions.reduce((s, p) => s + p.marketValue, 0);
  return {
    source: "ibkr",
    syncedAt: typeof o.syncedAt === "string" ? o.syncedAt : new Date(0).toISOString(),
    currency: typeof o.currency === "string" ? o.currency : "USD",
    cash,
    netLiquidation: num(o.netLiquidation) ?? gross + cash,
    grossPositionValue: gross,
    buyingPower: num(o.buyingPower),
    positions,
  };
}

export interface Holding extends Position {
  weight: number; // fraction of net liquidation
  pnlPct: number; // vs average cost
}

export const CONCENTRATION_WARN = 0.2; // one position above 20% of the account

export function holdings(pf: Portfolio): Holding[] {
  const base = pf.netLiquidation > 0 ? pf.netLiquidation : pf.grossPositionValue || 1;
  return pf.positions.map((p) => ({
    ...p,
    weight: p.marketValue / base,
    pnlPct: p.avgCost > 0 ? p.marketPrice / p.avgCost - 1 : 0,
  }));
}

export const findHolding = (pf: Portfolio | null | undefined, symbol: string) =>
  pf?.positions.find((p) => p.ticker === symbol.toUpperCase());

/** Hours since the last sync. */
export const syncAgeHours = (pf: Portfolio, now = Date.now()) => (now - new Date(pf.syncedAt).getTime()) / 3_600_000;
