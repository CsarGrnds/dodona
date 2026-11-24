// Pure and shared: the budget decides the safeguards, and says which strategies it can pay for.
//
// 1. Limits from the budget. With "auto_from_budget" on, the dollar limits every /trader-* skill and
//    Dodona's gates read (max loss per trade, daily loss, biggest order) are worked out from the budget
//    and two percentages, so $200 and $5,000 each get limits their size. They're still written to
//    trader/config.json as dollars, so the skills never need to know.
// 2. What the budget can pay for. A trade's fees are fixed-ish ($1 a side at IBKR's fixed pricing) while
//    its risk shrinks with the budget. fitFor() works out, per strategy, how much of a typical trade's
//    risk goes to fees, and the smallest budget where that drops to a quarter.
import { ibkrFeeEstimate } from "./ibkrOrder";

/** The percentages used when the budget sets the limits. Common risk-management defaults, changeable in Settings. */
export const BUDGET_DEFAULTS = { risk_pct: 2, daily_loss_pct: 5 };

const cents = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown, d: number) => {
  if (v === undefined || v === null || String(v).trim() === "") return d;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[$,%\s]/g, ""));
  return Number.isFinite(n) ? n : d;
};

/** The dollar limits a budget gets: risk_pct of it per trade, daily_loss_pct per day, and orders up to what isn't kept in cash. */
export function limitsFromBudget(r: { budget?: unknown; risk_pct?: unknown; daily_loss_pct?: unknown; cash_buffer_pct?: unknown }) {
  const budget = num(r.budget, 0);
  const risk = num(r.risk_pct, BUDGET_DEFAULTS.risk_pct);
  const day = num(r.daily_loss_pct, BUDGET_DEFAULTS.daily_loss_pct);
  const buffer = Math.min(100, Math.max(0, num(r.cash_buffer_pct, 10)));
  return {
    max_loss_per_trade_usd: Math.max(0.01, cents((budget * risk) / 100)),
    max_daily_loss_usd: Math.max(0.01, cents((budget * day) / 100)),
    max_order_usd: Math.max(1, cents(budget * (1 - buffer / 100))),
  };
}

/** The same rules with the dollar limits filled in from the budget, when "auto_from_budget" is on. */
export function applyBudget<T extends Record<string, unknown>>(r: T): T {
  if (r.auto_from_budget !== true || !(num(r.budget, 0) > 0)) return r;
  return { ...r, ...limitsFromBudget(r) };
}

// ---------------------------------------------------------------- what the budget can pay for

export interface Strategy {
  id: "orb" | "swing";
  label: string;
  hold: string;
  stopPct: number; // a typical stop's distance, % of the price
  source: string; // where stopPct comes from
  built: boolean; // can the team trade it today?
}

export const STRATEGIES: Strategy[] = [
  { id: "orb", label: "Day trades", hold: "opening-range breakout, sold by the close", stopPct: 2.3, source: "the average stop in Dodona's backtest of the live scan (Sep–Nov 2026)", built: true },
  { id: "swing", label: "Swing trades", hold: "held 2–10 days", stopPct: 6, source: "a typical stop under a daily swing low", built: false },
];

/** Fees under this share of the risk: the trade can pay for itself. Under TIGHT: it can, barely. */
export const FEE_FITS = 25;
export const FEE_TIGHT = 50;
const PRICE = 50; // a typical shortlisted share price; at small sizes IBKR's $1 minimum decides the fee anyway

export interface StrategyFit extends Strategy {
  shares: number;
  position: number; // $ in the trade
  risk: number; // $ lost at the stop
  fee: number; // IBKR commissions in and out
  feePct: number; // fee as % of risk
  verdict: "fits" | "tight" | "no";
  minBudget?: number; // the smallest budget where fees are FEE_FITS% of the risk or less, same rules
}

export interface BudgetFit {
  budget: number;
  tradable: number; // what a trade may cost
  maxLoss: number;
  maxFeePct?: number; // the user's own gate (Settings → Risk → Max fees vs risk)
  strategies: StrategyFit[];
}

interface Rules {
  budget?: unknown;
  cash_buffer_pct?: unknown;
  max_position_pct?: unknown;
  max_order_usd?: unknown;
  max_loss_per_trade_usd?: unknown;
  max_fee_pct?: unknown;
  auto_from_budget?: unknown;
  risk_pct?: unknown;
  daily_loss_pct?: unknown;
}

/** One typical trade of this strategy under these rules: size it like the desk does, then price the fees. */
function typical(r: Rules, s: Strategy): Omit<StrategyFit, "minBudget"> {
  const rr = applyBudget(r as Record<string, unknown>) as Rules;
  const budget = num(rr.budget, 0);
  const tradable = Math.min(budget * (1 - num(rr.cash_buffer_pct, 10) / 100), (budget * num(rr.max_position_pct, 75)) / 100, num(rr.max_order_usd, Infinity));
  const maxLoss = num(rr.max_loss_per_trade_usd, 50);
  const price = Math.min(PRICE, Math.max(tradable, 0.01)); // a small account buys a cheaper stock
  const perShare = (price * s.stopPct) / 100;
  const shares = Math.max(0, Math.min(Math.floor(tradable / price), Math.floor(maxLoss / perShare)));
  const risk = cents(shares * perShare);
  const fee = shares ? ibkrFeeEstimate(shares, price) : 0;
  const feePct = risk > 0 ? Math.round((fee / risk) * 100) : Infinity;
  return { ...s, shares, position: cents(shares * price), risk, fee, feePct, verdict: feePct <= FEE_FITS ? "fits" : feePct <= FEE_TIGHT ? "tight" : "no" };
}

const LADDER = [100, 150, 200, 300, 400, 500, 750, 1000, 1500, 2000, 3000, 4000, 5000, 7500, 10000, 15000, 25000, 50000, 100000];

export function fitFor(r: Rules): BudgetFit {
  const rr = applyBudget(r as Record<string, unknown>) as Rules;
  const budget = num(rr.budget, 0);
  const strategies = STRATEGIES.map((s) => {
    const t = typical(r, s);
    // the same rules at a bigger budget: percentages stay, fixed dollar limits stay fixed
    const minBudget = t.verdict === "fits" ? undefined : LADDER.find((b) => b > budget && typical({ ...r, budget: b }, s).verdict === "fits");
    return { ...t, ...(minBudget ? { minBudget } : {}) };
  });
  const tradable = Math.min(budget * (1 - num(rr.cash_buffer_pct, 10) / 100), (budget * num(rr.max_position_pct, 75)) / 100, num(rr.max_order_usd, Infinity));
  const maxFee = num(rr.max_fee_pct, NaN);
  return { budget, tradable: cents(tradable), maxLoss: num(rr.max_loss_per_trade_usd, 50), ...(Number.isFinite(maxFee) ? { maxFeePct: maxFee } : {}), strategies };
}

/** One plain sentence per strategy, for Settings and the Desk. */
export function fitLine(f: StrategyFit): string {
  const k = (n: number) => (n >= 1000 ? `$${(n / 1000).toLocaleString("en-US", { maximumFractionDigits: 1 })}k` : `$${n}`);
  if (!f.shares) return `${f.label}: can't size even one share under these limits.${f.minBudget ? ` Needs about ${k(f.minBudget)}.` : ""}`;
  const base = `${f.label} (${f.hold}): a typical trade risks $${f.risk.toFixed(2)} and pays about $${f.fee.toFixed(2)} in IBKR fees, ${f.feePct}% of the risk.`;
  if (f.verdict === "fits") return `${base} Fits your budget.`;
  return `${base} ${f.verdict === "tight" ? "Barely pays for itself" : "Fees eat the trade"}${f.minBudget ? `; fits from about ${k(f.minBudget)} with the same rules` : ""}.`;
}

/**
 * The rules in force, read from trader/config.json at that moment, as one line for the trade team:
 * printed by `desk session start` and put in every run's instructions, so a run never works from
 * numbers it remembers from an earlier run.
 */
export function rulesBrief(cfg: Record<string, unknown>): string {
  const r = applyBudget(cfg);
  const n = (k: string, d = 0) => num(r[k], d);
  const usd = (x: number) => `$${Math.round(x * 100) / 100}`;
  const budget = n("budget");
  const buffer = n("cash_buffer_pct", 10);
  const auto = r.auto_from_budget === true;
  const perTrade = Math.min((budget * (100 - buffer)) / 100, (budget * n("max_position_pct", 75)) / 100, n("max_order_usd", Infinity));
  return [
    `trading money ${usd(budget)} (${buffer}% kept in cash, so up to ${usd(perTrade)} in one trade)`,
    `max loss ${usd(n("max_loss_per_trade_usd", 50))} a trade and ${usd(n("max_daily_loss_usd", 150))} a day${auto ? ` (${n("risk_pct", BUDGET_DEFAULTS.risk_pct)}% and ${n("daily_loss_pct", BUDGET_DEFAULTS.daily_loss_pct)}% of the money)` : ""}`,
    `up to ${n("max_trades_per_day", 3)} trades a day`,
    `fees at most ${n("max_fee_pct", 25)}% of a trade's risk`,
    `entries ${String(r.no_entries_before ?? "09:45")}-${String(r.no_entries_after ?? "15:30")} New York`,
    r.paper === false ? "REAL MONEY (paper is off)" : "practice (paper is on)",
  ].join("; ");
}
