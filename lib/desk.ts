// The agentic trading desk: a PAPER account that Claude (or the rules engine) trades on its own,
// inside the rules in trader/config.json. Pure and shared: sizing, the risk gate, fills from
// bars, the ledger and the daily P&L history. Nothing here talks to a broker.

import type { TrackRecord } from "./backtest";
import { nyClock } from "./setups";

// ---------------------------------------------------------------- rules (trader/config.json)

export interface DeskRules {
  budget: number;
  cash_buffer_pct: number;
  max_position_pct: number;
  max_order_usd: number;
  min_order_usd: number;
  max_loss_per_trade_usd: number;
  max_daily_loss_usd: number;
  max_trades_per_day: number;
  min_reward_risk: number;
  require_stop: boolean;
  no_entries_before: string; // "09:45", New York
  no_entries_after: string; // "15:30"
  flat_by: string; // "15:55"
  fractional: boolean;
  blocked: string[];
}

/** trader-budget's example config: the defaults when trader/config.json is missing or partial. */
export const DEFAULT_DESK_RULES: DeskRules = {
  budget: 5000,
  cash_buffer_pct: 10,
  max_position_pct: 75,
  max_order_usd: 4000,
  min_order_usd: 5,
  max_loss_per_trade_usd: 50,
  max_daily_loss_usd: 150,
  max_trades_per_day: 3,
  min_reward_risk: 1,
  require_stop: true,
  no_entries_before: "09:45",
  no_entries_after: "15:30",
  flat_by: "15:55",
  fractional: false,
  blocked: [],
};

export function normalizeDeskRules(raw: unknown): DeskRules {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const num = (k: keyof DeskRules, lo = 0) => {
    const v = Number(o[k]);
    return Number.isFinite(v) && v >= lo ? v : (DEFAULT_DESK_RULES[k] as number);
  };
  const hhmm = (k: keyof DeskRules) => (typeof o[k] === "string" && /^\d{1,2}:\d{2}$/.test(o[k] as string) ? (o[k] as string) : (DEFAULT_DESK_RULES[k] as string));
  return {
    budget: num("budget", 1),
    cash_buffer_pct: Math.min(100, num("cash_buffer_pct")),
    max_position_pct: Math.min(100, num("max_position_pct", 1)),
    max_order_usd: num("max_order_usd", 1),
    min_order_usd: num("min_order_usd"),
    max_loss_per_trade_usd: num("max_loss_per_trade_usd", 0.01),
    max_daily_loss_usd: num("max_daily_loss_usd", 0.01),
    max_trades_per_day: Math.floor(num("max_trades_per_day")),
    min_reward_risk: num("min_reward_risk"),
    require_stop: o.require_stop === undefined ? true : Boolean(o.require_stop),
    no_entries_before: hhmm("no_entries_before"),
    no_entries_after: hhmm("no_entries_after"),
    flat_by: hhmm("flat_by"),
    fractional: Boolean(o.fractional),
    blocked: Array.isArray(o.blocked) ? o.blocked.map((s) => String(s).toUpperCase()) : [],
  };
}

export const minuteOf = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

// ---------------------------------------------------------------- ledger

export type Style = "day" | "swing";
export type Agent = "claude" | "rules";
export type ExitReason = "target" | "stop" | "flat-by" | "time" | "agent";

export interface DeskPosition {
  id: string;
  symbol: string;
  style: Style;
  setup: string; // "Opening-range breakout", "20-day breakout"…
  qty: number;
  entry: number; // fill price, slippage included
  stop: number;
  initialStop: number; // risk is measured from this one
  target: number;
  openedAt: string; // ISO
  entryDate: string; // New York date
  maxHoldDays: number; // swing time stop, in trading sessions
  by: Agent;
  confidence?: number;
  thesis: string;
  fees: number; // entry commission
  lastPrice: number;
  lastAt: string;
}

export interface DeskTrade extends Omit<DeskPosition, "lastPrice" | "lastAt"> {
  exit: number;
  exitAt: string;
  exitDate: string;
  reason: ExitReason;
  exitNote: string;
  pnl: number; // after fees
  R: number; // pnl / initial risk
}

export type JournalKind = "buy" | "skip" | "blocked" | "sell" | "stop-raised" | "hold" | "note";

export interface JournalEntry {
  at: string;
  kind: JournalKind;
  symbol?: string;
  by: Agent | "desk";
  text: string;
}

export interface DeskDay {
  date: string; // New York
  equity: number; // last mark of the day
  realized: number; // closed-trade P&L that day, after fees
  fees: number;
  opened: number;
  closed: number;
  wins: number;
  losses: number;
}

export interface DeskState {
  version: 1;
  startedAt: string;
  startCash: number;
  cash: number;
  positions: DeskPosition[];
  trades: DeskTrade[];
  journal: JournalEntry[];
  days: DeskDay[];
  reviewed: Record<string, string>; // candidate key → ISO, so Claude isn't asked twice about one signal
  lastRunAt?: string;
  lastAgentAt?: string;
  lastSummary?: string;
}

export const JOURNAL_MAX = 400;
export const SLIPPAGE = 0.0005; // 0.05% against us on every fill
export const COMMISSION = 0.35; // IBKR Pro tiered minimum per order
export const SWING_MAX_HOLD = 20;
export const MAX_FEE_SHARE = 0.25; // round-trip fees may be at most 25% of the trade's risk

export function newDesk(startCash: number, nowIso: string): DeskState {
  return { version: 1, startedAt: nowIso, startCash: r2(startCash), cash: r2(startCash), positions: [], trades: [], journal: [], days: [], reviewed: {} };
}

export const r2 = (v: number) => Math.round(v * 100) / 100;
export const floorCents = (v: number) => Math.floor(v * 100 + 1e-9) / 100;
const r4 = (v: number) => Math.round(v * 10_000) / 10_000;

export const marketValue = (s: DeskState) => s.positions.reduce((a, p) => a + p.qty * p.lastPrice, 0);
export const equityOf = (s: DeskState) => r2(s.cash + marketValue(s));
export const openRisk = (p: Pick<DeskPosition, "qty" | "entry" | "stop">) => Math.max(0, (p.entry - p.stop) * p.qty);

export function log(s: DeskState, e: Omit<JournalEntry, "at">, at: string) {
  s.journal.unshift({ at, ...e });
  if (s.journal.length > JOURNAL_MAX) s.journal.length = JOURNAL_MAX;
}

// ---------------------------------------------------------------- sizing (trader-budget's four limits)

export interface Sizing {
  qty: number;
  decidedBy: "max loss" | "position cap" | "max order" | "cash";
  limits: Record<Sizing["decidedBy"], number>;
  cost: number;
  maxLoss: number;
}

/** Whole shares (or 4-decimal fractions) inside max loss, position cap, max order and cash after the buffer. */
export function sizeTrade(rules: DeskRules, entry: number, stop: number, cash: number, equity: number): Sizing | { refused: string } {
  if (!(entry > 0)) return { refused: "no price" };
  const risk = entry - stop;
  if (!(risk > 0)) return { refused: "the stop is not below the entry" };
  const unit = (v: number) => (rules.fractional ? Math.floor(v * 10_000) / 10_000 : Math.floor(v + 1e-9));
  const base = Math.min(rules.budget, equity);
  const usable = Math.max(0, Math.min(cash, base - (base * rules.cash_buffer_pct) / 100 - (equity - cash)));
  const limits = {
    "max loss": unit(rules.max_loss_per_trade_usd / risk),
    "position cap": unit((base * rules.max_position_pct) / 100 / entry),
    "max order": unit(rules.max_order_usd / entry),
    cash: unit(usable / (entry * (1 + SLIPPAGE)) - COMMISSION / entry),
  };
  const decidedBy = (Object.keys(limits) as Sizing["decidedBy"][]).reduce((a, k) => (limits[k] < limits[a] ? k : a), "max loss");
  const qty = Math.max(0, limits[decidedBy]);
  if (qty <= 0) {
    const why = decidedBy === "max loss" ? `one share risks $${risk.toFixed(2)}, more than the $${rules.max_loss_per_trade_usd} max loss` : decidedBy === "cash" ? `not enough cash after the ${rules.cash_buffer_pct}% buffer` : `one share ($${entry.toFixed(2)}) is over the ${decidedBy}`;
    return { refused: why };
  }
  const cost = r2(qty * entry);
  if (cost < rules.min_order_usd) return { refused: `$${cost.toFixed(2)} is under the $${rules.min_order_usd} minimum order` };
  const fee = feeCheck(qty, risk);
  if (fee) return { refused: fee };
  return { qty, decidedBy, limits, cost, maxLoss: r2(qty * risk) };
}

/** Too small to be worth it: the round-trip commission would eat too much of what the trade risks. */
export function feeCheck(qty: number, risk: number): string | undefined {
  const fees = 2 * COMMISSION;
  const atRisk = qty * risk;
  if (fees > MAX_FEE_SHARE * atRisk) return `too small: $${fees.toFixed(2)} in fees against $${atRisk.toFixed(2)} at risk (fees may be at most ${MAX_FEE_SHARE * 100}% of the risk)`;
  return undefined;
}

// ---------------------------------------------------------------- risk gate (trader-risk's day rules)

export interface Proposal {
  symbol: string;
  style: Style;
  entry: number;
  stop: number;
  target: number;
}

export function riskGate(rules: DeskRules, s: DeskState, p: Proposal, nowMs: number, marketOpen: boolean): { ok: true } | { ok: false; reason: string } {
  const { date, minute } = nyClock(nowMs);
  if (!marketOpen) return { ok: false, reason: "the market is closed" };
  if (minute < minuteOf(rules.no_entries_before)) return { ok: false, reason: `no entries before ${rules.no_entries_before} New York time` };
  if (minute > minuteOf(rules.no_entries_after)) return { ok: false, reason: `no entries after ${rules.no_entries_after} New York time` };
  if (p.style === "day" && minute >= minuteOf(rules.flat_by)) return { ok: false, reason: `past the ${rules.flat_by} flat-by time` };
  if (rules.blocked.includes(p.symbol)) return { ok: false, reason: `${p.symbol} is on your blocked list` };
  if (s.positions.some((x) => x.symbol === p.symbol)) return { ok: false, reason: `already holding ${p.symbol}` };
  if (rules.require_stop && !(p.stop > 0)) return { ok: false, reason: "a stop is required" };
  if (!(p.stop < p.entry)) return { ok: false, reason: "the stop is not below the entry" };
  if (!(p.target > p.entry)) return { ok: false, reason: "the target is not above the entry" };
  const rr = (p.target - p.entry) / (p.entry - p.stop);
  if (rr < rules.min_reward_risk) return { ok: false, reason: `reward:risk ${rr.toFixed(2)} is under your ${rules.min_reward_risk}` };
  const opened = s.positions.filter((x) => x.entryDate === date).length + s.trades.filter((t) => t.entryDate === date).length;
  if (opened >= rules.max_trades_per_day) return { ok: false, reason: `already ${opened} trade${opened === 1 ? "" : "s"} today (limit ${rules.max_trades_per_day})` };
  const lostToday = Math.max(0, -s.trades.filter((t) => t.exitDate === date).reduce((a, t) => a + t.pnl, 0));
  const atRisk = s.positions.reduce((a, x) => a + openRisk(x), 0);
  if (lostToday >= rules.max_daily_loss_usd) return { ok: false, reason: `down $${lostToday.toFixed(2)} today: the $${rules.max_daily_loss_usd} daily loss limit is hit` };
  if (lostToday + atRisk >= rules.max_daily_loss_usd) return { ok: false, reason: `today's losses plus open risk ($${(lostToday + atRisk).toFixed(2)}) already fill the $${rules.max_daily_loss_usd} daily limit` };
  return { ok: true };
}

/** The room left under the daily limit for one more trade's max loss. */
export function dailyRoom(rules: DeskRules, s: DeskState, nowMs: number): number {
  const { date } = nyClock(nowMs);
  const lostToday = Math.max(0, -s.trades.filter((t) => t.exitDate === date).reduce((a, t) => a + t.pnl, 0));
  return Math.max(0, rules.max_daily_loss_usd - lostToday - s.positions.reduce((a, x) => a + openRisk(x), 0));
}

// ---------------------------------------------------------------- fills

export const buyFill = (price: number) => r4(price * (1 + SLIPPAGE));
export const sellFill = (price: number) => r4(price * (1 - SLIPPAGE));

export function openPosition(s: DeskState, p: Omit<DeskPosition, "id" | "fees" | "lastPrice" | "lastAt" | "initialStop">, at: string): DeskPosition {
  const pos: DeskPosition = { ...p, id: `${p.symbol}-${Date.parse(at).toString(36)}`, initialStop: p.stop, fees: COMMISSION, lastPrice: p.entry, lastAt: at };
  s.cash = r2(s.cash - p.qty * p.entry - COMMISSION);
  s.positions.push(pos);
  return pos;
}

export function closePosition(s: DeskState, id: string, price: number, at: string, reason: ExitReason, note: string): DeskTrade | undefined {
  const i = s.positions.findIndex((p) => p.id === id);
  if (i < 0) return;
  const p = s.positions[i];
  const exit = sellFill(price);
  const fees = r2(p.fees + COMMISSION);
  const pnl = r2((exit - p.entry) * p.qty - fees);
  const risk = (p.entry - p.initialStop) * p.qty;
  const { lastPrice: _lp, lastAt: _la, ...rest } = p;
  const t: DeskTrade = { ...rest, fees, exit, exitAt: at, exitDate: nyClock(Date.parse(at)).date, reason, exitNote: note, pnl, R: risk > 0 ? r2(pnl / risk) : 0 };
  s.cash = r2(s.cash + p.qty * exit - COMMISSION);
  s.positions.splice(i, 1);
  s.trades.push(t);
  return t;
}

/** A stop only ever moves up, and never to or above the price. */
export function raiseStop(p: DeskPosition, newStop: number): { ok: boolean; why: string } {
  const ns = floorCents(newStop);
  if (!(ns > p.stop)) return { ok: false, why: `$${ns.toFixed(2)} is not above the current stop $${p.stop.toFixed(2)}` };
  if (!(ns < p.lastPrice)) return { ok: false, why: `$${ns.toFixed(2)} is not below the price $${p.lastPrice.toFixed(2)}` };
  p.stop = ns;
  return { ok: true, why: `stop raised to $${ns.toFixed(2)}` };
}

export interface PriceBar {
  t: number; // bar start, epoch ms
  open: number;
  high: number;
  low: number;
  close: number;
  minutes: number; // bar length
}

export interface ExitHit {
  price: number;
  at: number; // epoch ms
  reason: ExitReason;
  note: string;
}

/**
 * Replay the bars since the entry and return the first exit: the stop (gaps fill at the open),
 * the target, or for a day trade the flat-by bar. A bar that touches both counts as the stop.
 */
export function findExit(p: Pick<DeskPosition, "style" | "stop" | "target" | "openedAt" | "entryDate">, bars: PriceBar[], flatBy: number, nowMs: number): ExitHit | null {
  const since = Date.parse(p.openedAt);
  let prev: PriceBar | undefined;
  for (const b of bars) {
    if (b.t < since) continue; // the entry bar may already be past: only bars that start after it
    const end = b.t + b.minutes * 60_000;
    const { date, minute } = nyClock(b.t);
    if (p.style === "day") {
      // a later day's bar: the session ended without a flat-by bar, so out at the last close
      if (date !== p.entryDate) {
        const px = prev?.close ?? b.open;
        return { price: px, at: prev ? prev.t + prev.minutes * 60_000 : b.t, reason: "flat-by", note: `day trade closed at the session's last price $${px.toFixed(2)}` };
      }
      if (minute + b.minutes > flatBy && b.t <= nowMs) {
        return { price: b.open, at: b.t, reason: "flat-by", note: `flat by ${clock(flatBy)}: closed at $${b.open.toFixed(2)}` };
      }
    }
    if (end > nowMs) break; // still forming
    prev = b;
    if (b.low <= p.stop) {
      const px = Math.min(p.stop, b.open);
      return { price: px, at: end, reason: "stop", note: px < p.stop ? `opened at $${px.toFixed(2)}, under the $${p.stop.toFixed(2)} stop` : `stop $${p.stop.toFixed(2)} hit` };
    }
    if (b.high >= p.target) {
      const px = Math.max(p.target, b.open);
      return { price: px, at: end, reason: "target", note: `target $${p.target.toFixed(2)} hit` };
    }
  }
  return null;
}

const clock = (minute: number) => `${((Math.floor(minute / 60) + 11) % 12) + 1}:${String(minute % 60).padStart(2, "0")} ${minute < 720 ? "AM" : "PM"}`;

/** The rules engine's call: take a setup only when its own past trades on this stock made money. */
export function rulesVerdict(c: { record?: TrackRecord; marketTrend?: "up" | "down" | "mixed" }): { take: boolean; why: string } {
  const r = c.record;
  if (!r || r.sample === "none") return { take: false, why: "no past trades of this setup on this stock to judge it by" };
  if (c.marketTrend === "down") return { take: false, why: "the market (SPY) is in a downtrend: no new longs" };
  if (r.sample === "thin" && r.avgR < 0.5) return { take: false, why: `only ${r.trades} past trades and ${r.avgR >= 0 ? "+" : ""}${r.avgR}R each: too few to trust` };
  if (r.avgR <= 0.1) return { take: false, why: `its track record here is ${r.avgR >= 0 ? "+" : ""}${r.avgR}R a trade over ${r.trades}: no edge` };
  return { take: true, why: `${r.verdict} (${Math.round(r.winRate * 100)}% winners)` };
}

// ---------------------------------------------------------------- history and stats

/** Record the latest mark for today (one row per New York date). */
export function markDay(s: DeskState, nowMs: number) {
  const { date } = nyClock(nowMs);
  const closedToday = s.trades.filter((t) => t.exitDate === date);
  const day: DeskDay = {
    date,
    equity: equityOf(s),
    realized: r2(closedToday.reduce((a, t) => a + t.pnl, 0)),
    fees: r2(closedToday.reduce((a, t) => a + t.fees, 0)),
    opened: s.positions.filter((p) => p.entryDate === date).length + s.trades.filter((t) => t.entryDate === date).length,
    closed: closedToday.length,
    wins: closedToday.filter((t) => t.pnl > 0).length,
    losses: closedToday.filter((t) => t.pnl <= 0).length,
  };
  const i = s.days.findIndex((d) => d.date === date);
  if (i >= 0) s.days[i] = day;
  else {
    s.days.push(day);
    s.days.sort((a, b) => a.date.localeCompare(b.date));
  }
}

export interface DayPnl extends DeskDay {
  pnl: number; // equity change vs the previous mark (the start cash on day one)
  pnlPct: number;
}

export function dailyPnl(s: DeskState): DayPnl[] {
  let prev = s.startCash;
  return s.days.map((d) => {
    const pnl = r2(d.equity - prev);
    const out = { ...d, pnl, pnlPct: prev > 0 ? pnl / prev : 0 };
    prev = d.equity;
    return out;
  });
}

export interface DeskStats {
  equity: number;
  totalPnl: number;
  totalPct: number;
  today?: DayPnl;
  trades: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  profitFactor?: number; // gross wins / gross losses
  expectancy: number; // average $ per trade
  avgR: number;
  bestDay?: DayPnl;
  worstDay?: DayPnl;
  greenDays: number;
  redDays: number;
  maxDrawdown: number; // fraction, negative
  streak: { kind: "win" | "loss" | "none"; n: number };
  fees: number;
  byStyle: Record<Style, { trades: number; pnl: number; winRate: number }>;
  bySetup: Array<{ setup: string; trades: number; pnl: number; winRate: number; avgR: number }>;
  byAgent: Record<Agent, { trades: number; pnl: number }>;
}

export function deskStats(s: DeskState, nowMs: number): DeskStats {
  const days = dailyPnl(s);
  const today = days.find((d) => d.date === nyClock(nowMs).date);
  const t = s.trades;
  const wins = t.filter((x) => x.pnl > 0);
  const losses = t.filter((x) => x.pnl <= 0);
  const gw = wins.reduce((a, x) => a + x.pnl, 0);
  const gl = -losses.reduce((a, x) => a + x.pnl, 0);
  const equity = equityOf(s);
  let peak = s.startCash;
  let mdd = 0;
  for (const d of days) {
    peak = Math.max(peak, d.equity);
    mdd = Math.min(mdd, peak > 0 ? d.equity / peak - 1 : 0);
  }
  let streak: DeskStats["streak"] = { kind: "none", n: 0 };
  for (let i = t.length - 1; i >= 0; i--) {
    const k = t[i].pnl > 0 ? "win" : "loss";
    if (streak.kind === "none") streak = { kind: k, n: 1 };
    else if (streak.kind === k) streak.n++;
    else break;
  }
  const group = <K extends string>(key: (x: DeskTrade) => K) => {
    const m = new Map<K, DeskTrade[]>();
    for (const x of t) m.set(key(x), [...(m.get(key(x)) ?? []), x]);
    return m;
  };
  const summary = (xs: DeskTrade[]) => ({ trades: xs.length, pnl: r2(xs.reduce((a, x) => a + x.pnl, 0)), winRate: xs.length ? xs.filter((x) => x.pnl > 0).length / xs.length : 0 });
  const styles = group((x) => x.style);
  const agents = group((x) => x.by);
  const setups = group((x) => x.setup);
  const sorted = [...days].sort((a, b) => a.pnl - b.pnl);
  return {
    equity,
    totalPnl: r2(equity - s.startCash),
    totalPct: s.startCash > 0 ? equity / s.startCash - 1 : 0,
    today,
    trades: t.length,
    winRate: t.length ? wins.length / t.length : 0,
    avgWin: wins.length ? r2(gw / wins.length) : 0,
    avgLoss: losses.length ? r2(-gl / losses.length) : 0,
    profitFactor: gl > 0 ? r2(gw / gl) : undefined,
    expectancy: t.length ? r2((gw - gl) / t.length) : 0,
    avgR: t.length ? r2(t.reduce((a, x) => a + x.R, 0) / t.length) : 0,
    bestDay: sorted.length && sorted[sorted.length - 1].pnl > 0 ? sorted[sorted.length - 1] : undefined,
    worstDay: sorted.length && sorted[0].pnl < 0 ? sorted[0] : undefined,
    greenDays: days.filter((d) => d.pnl > 0).length,
    redDays: days.filter((d) => d.pnl < 0).length,
    maxDrawdown: mdd,
    streak,
    fees: r2(t.reduce((a, x) => a + x.fees, 0) + s.positions.reduce((a, p) => a + p.fees, 0)),
    byStyle: { day: summary(styles.get("day") ?? []), swing: summary(styles.get("swing") ?? []) },
    byAgent: { claude: summary(agents.get("claude") ?? []), rules: summary(agents.get("rules") ?? []) },
    bySetup: [...setups.entries()]
      .map(([setup, xs]) => ({ setup, ...summary(xs), avgR: r2(xs.reduce((a, x) => a + x.R, 0) / xs.length) }))
      .sort((a, b) => b.pnl - a.pnl),
  };
}

/** Validate a stored desk file; unknown shapes start fresh instead of crashing the page. */
export function parseDesk(raw: unknown): DeskState | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as DeskState;
  if (o.version !== 1 || !Number.isFinite(o.startCash) || !Number.isFinite(o.cash) || !Array.isArray(o.positions) || !Array.isArray(o.trades)) return null;
  return { ...o, journal: Array.isArray(o.journal) ? o.journal : [], days: Array.isArray(o.days) ? o.days : [], reviewed: o.reviewed && typeof o.reviewed === "object" ? o.reviewed : {} };
}
