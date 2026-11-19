// Pure: turning trader-budget's bracket orders (Alpaca's shape, checked by trader-risk) into
// Interactive Brokers' Client Portal Web API orders, and reading what IBKR answers.
//
// An IBKR bracket is sent as one request: the parent (the buy) and children that name it as their
// parentId: a take-profit limit sell, a stop-loss stop sell and, for a day trade, a market-on-close
// sell. Children only work once the parent fills. Per IBKR's docs, children carry no cOID of their
// own, and only one bracket goes in a request.
//
// The entry can be a market buy, a limit buy, or a buy-STOP: the order waits at IBKR and buys the
// moment the price trades at the trigger, so a breakout is never missed while you are away.

export interface BracketPlan {
  symbol: string;
  qty: number;
  stop: number;
  target: number;
  entry: number; // the plan's entry (for a buy-stop: the trigger), for the max loss
  limit?: number; // a limit entry
  trigger?: number; // a buy-stop entry: buys at market once the price trades at or above it
  closeAtEnd?: boolean; // a day trade: sell at the close (MOC) if neither the stop nor the target filled
}

export interface IbkrOrder {
  acctId: string;
  conid: number;
  cOID?: string;
  parentId?: string;
  orderType: "MKT" | "LMT" | "STP" | "MOC";
  side: "BUY" | "SELL";
  quantity: number;
  price?: number;
  tif: "DAY";
  outsideRTH: false;
}

/** IBKR paper accounts start with D (DU1234567); live ones with U. */
export const isPaperAccount = (id?: string) => !!id && /^D/i.test(id.trim());

const cents = (n: number) => Math.round(n * 100) / 100;

/** The price the max loss is measured from: the worst of the plan's entry, the limit and the trigger. */
export const entryRef = (p: BracketPlan) => Math.max(p.entry, p.limit ?? 0, p.trigger ?? 0);
export const maxLossOf = (p: BracketPlan) => cents(p.qty * (entryRef(p) - p.stop));

export function ibkrBracket(p: BracketPlan, acctId: string, conid: number, cOID: string): IbkrOrder[] {
  if (!(p.qty > 0) || !Number.isInteger(p.qty)) throw new Error("whole shares only");
  if (!(p.stop > 0 && p.target > p.stop)) throw new Error("the stop must be below the target");
  if (p.limit !== undefined && p.trigger !== undefined) throw new Error("a limit or a trigger entry, not both");
  if (p.limit !== undefined && !(p.limit > p.stop && p.limit < p.target)) throw new Error("the limit must sit between the stop and the target");
  if (p.trigger !== undefined && !(p.trigger > p.stop && p.trigger < p.target)) throw new Error("the trigger must sit between the stop and the target");
  const base = { acctId, conid, quantity: p.qty, tif: "DAY" as const, outsideRTH: false as const };
  const entry =
    p.trigger !== undefined ? { orderType: "STP" as const, price: cents(p.trigger) } : p.limit !== undefined ? { orderType: "LMT" as const, price: cents(p.limit) } : { orderType: "MKT" as const };
  const out: IbkrOrder[] = [
    { ...base, cOID, side: "BUY", ...entry },
    { ...base, parentId: cOID, side: "SELL", orderType: "LMT", price: cents(p.target) },
    { ...base, parentId: cOID, side: "SELL", orderType: "STP", price: cents(p.stop) },
  ];
  if (p.closeAtEnd) out.push({ ...base, parentId: cOID, side: "SELL", orderType: "MOC" });
  return out;
}

/** The ticket in plain words, as trader-broker shows it. */
export function ticketLines(p: BracketPlan, account: string, paper: boolean): string[] {
  const how = p.trigger !== undefined ? `when it trades at $${p.trigger.toFixed(2)} or higher (buy-stop, waits at IBKR)` : p.limit !== undefined ? `limit $${p.limit.toFixed(2)}` : "market";
  return [
    `${paper ? "PAPER" : "LIVE"} account ${account}, Interactive Brokers`,
    `BUY ${p.qty} ${p.symbol}, ${how}, good for today`,
    `stop-loss $${p.stop.toFixed(2)} · take-profit $${p.target.toFixed(2)} (one cancels the other)${p.closeAtEnd ? "; else sold at the close" : ""}`,
    `max loss about $${maxLossOf(p).toFixed(2)} if the stop fills at $${p.stop.toFixed(2)}; in a fast market it can fill worse`,
  ];
}

export interface PlaceAnswer {
  placed: Array<{ orderId: string; status?: string; cOID?: string }>;
  questions: Array<{ id: string; messages: string[] }>;
  error?: string;
}

/**
 * IBKR answers an order (or a reply) with either the orders it accepted, or questions that must be
 * confirmed first ("This order will be placed at market…", price-cap warnings, …). Questions are
 * never answered automatically: each goes back to the user.
 */
export function parsePlaceAnswer(raw: unknown): PlaceAnswer {
  const out: PlaceAnswer = { placed: [], questions: [] };
  const o = raw as Record<string, unknown> | null;
  if (o && !Array.isArray(o) && typeof o.error === "string") return { ...out, error: o.error };
  for (const r of (Array.isArray(raw) ? raw : raw ? [raw] : []) as Array<Record<string, unknown>>) {
    if (r.order_id !== undefined || r.orderId !== undefined) out.placed.push({ orderId: String(r.order_id ?? r.orderId), status: r.order_status ? String(r.order_status) : undefined, cOID: r.local_order_id ? String(r.local_order_id) : undefined });
    else if (r.id !== undefined) out.questions.push({ id: String(r.id), messages: (Array.isArray(r.message) ? r.message : [r.message]).filter(Boolean).map(String) });
    else if (typeof r.error === "string") out.error = r.error;
  }
  return out;
}

/** "2026-10-19T10:15:00-04:00": the New York wall clock with its offset, like trader-broker's log. */
export function nyIso(ms: number): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZoneName: "shortOffset" })
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value]),
  );
  const off = Number((parts.timeZoneName ?? "GMT-5").replace("GMT", "") || 0);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${off < 0 ? "-" : "+"}${String(Math.abs(off)).padStart(2, "0")}:00`;
}

/**
 * IBKR's fixed commission for US stocks, in and out: $0.005 a share, at least $1.00 and at most 1% of
 * the trade, each way (what the live preview charged: $1.00 for 13 shares). An estimate: the
 * preview shows the real figure.
 */
export function ibkrFeeEstimate(qty: number, price: number): number {
  const side = Math.min(Math.max(1, 0.005 * qty), 0.01 * qty * price);
  return cents(2 * side);
}
/** Fees may be at most this share of what the trade risks: 25% by default (the paper desk's rule), or the user's own "max_fee_pct" from Settings. */
export const MAX_FEE_SHARE = 0.25;
export function feeProblem(p: BracketPlan, maxShare = MAX_FEE_SHARE): string | undefined {
  const fee = ibkrFeeEstimate(p.qty, entryRef(p));
  const risk = maxLossOf(p);
  return fee > risk * maxShare ? `${p.symbol}: about $${fee.toFixed(2)} in IBKR commissions (in and out) against $${risk.toFixed(2)} of risk; your limit is fees at most ${Math.round(maxShare * 100)}% of the risk (Settings → Risk → Max fees vs risk).` : undefined;
}

type QS = { qty: number; symbol: string };
const one = (p: QS) => `${p.qty} ${p.symbol.toUpperCase()}`;
/** What the user types to place them: "8 TSLA", or for a batch "8 TSLA, 5 F". */
export const confirmPhrase = (p: QS | QS[]) => (Array.isArray(p) ? p : [p]).map(one).join(", ");
const norm = (s: string) => s.trim().toUpperCase().replace(/\s*,\s*/g, ", ").replace(/\s+/g, " ");
export const confirmMatches = (typed: string, p: QS | QS[]) => norm(typed ?? "") === confirmPhrase(p);

/** IBKR writes money as text: "11.36 USD (1 Shares)", "1,234.50 USD". The first number is the amount. */
export function ibkrMoney(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  const m = String(v ?? "").match(/-?\d[\d,]*(?:\.\d+)?/);
  return m ? Number(m[0].replace(/,/g, "")) : undefined;
}

/** IBKR's warnings come as "20/You are trying to…": drop the code, keep the words. */
export const ibkrWarning = (v: unknown) => (v ? String(v).replace(/^\d+\//, "").replace(/\s+/g, " ").trim() : undefined);

// ---------------------------------------------------------------- stop tickets (Today's "raise this stop")

/** A change to the stop protecting a holding: raise the stop order resting at IBKR, or set one where there is none. */
export interface StopChange {
  symbol: string;
  qty: number; // the shares the stop sells
  to: number; // the new stop
  from?: number; // the stop at IBKR now; none = a new stop order
  orderId?: string;
  tif: "GTC" | "DAY";
}

/** What the server read just now, from IBKR, about the holding. */
export interface StopFacts {
  shares: number;
  avgCost: number;
  price: number;
  noLoss: boolean; // the user's "Never sell at a loss" rule
  stops: Array<{ orderId: string; kind: string; stop?: number; qty: number; tif: string }>; // its sell stops resting at IBKR
}

const floorC = (v: number) => Math.floor(v * 100 + 1e-9) / 100;

/** The stop change for a new stop price, or why it can't be made from Dodona. Pure. Stops only move up; a stop never sells more than you hold. */
export function planStopChange(symbol: string, toRaw: number, f: StopFacts): { ok: true; change: StopChange } | { ok: false; reason: string } {
  const sym = symbol.toUpperCase();
  const to = floorC(toRaw);
  if (!(to > 0)) return { ok: false, reason: "The new stop must be a price above $0." };
  if (!(f.shares > 0)) return { ok: false, reason: `You don't hold ${sym} at IBKR.` };
  if (!(f.price > 0)) return { ok: false, reason: `No price for ${sym}.` };
  if (to >= f.price) return { ok: false, reason: `$${to.toFixed(2)} is at or above the price $${f.price.toFixed(2)}: a sell stop there fills at once.` };
  if (f.noLoss && f.avgCost > 0 && to < Math.ceil(f.avgCost * 100 - 1e-9) / 100)
    return { ok: false, reason: `$${to.toFixed(2)} is under your average cost $${f.avgCost.toFixed(2)}, and your rule is never to sell at a loss.` };
  if (f.stops.length > 1) return { ok: false, reason: `${sym} has ${f.stops.length} stop orders at IBKR; change them in IBKR so nothing sells twice.` };
  const cur = f.stops[0];
  if (cur) {
    if (cur.kind !== "stop") return { ok: false, reason: `${sym}'s stop is a ${cur.kind} order; change it in IBKR.` };
    if (!(cur.stop! > 0)) return { ok: false, reason: `Couldn't read the price of ${sym}'s stop order.` };
    if (to <= cur.stop!) return { ok: false, reason: `Stops only move up: $${to.toFixed(2)} isn't above the current $${cur.stop!.toFixed(2)}.` };
    if (cur.qty > f.shares + 1e-6) return { ok: false, reason: `The stop order sells ${cur.qty} shares but you hold ${f.shares}; fix it in IBKR.` };
    // IBKR's API refuses to modify an order for a fractional quantity ("Fractional quantity is not supported for this modification")
    if (!Number.isInteger(cur.qty)) return { ok: false, reason: `${sym}'s stop sells ${+cur.qty.toFixed(4)} shares, a fraction, and IBKR doesn't let Dodona change a fractional order. Raise it to $${to.toFixed(2)} in IBKR (TWS, IBKR Mobile or the Client Portal).` };
    const tif = cur.tif.toUpperCase() === "DAY" ? "DAY" : "GTC";
    return { ok: true, change: { symbol: sym, qty: cur.qty, to, from: cur.stop, orderId: cur.orderId, tif } };
  }
  const qty = Math.floor(f.shares + 1e-9);
  if (qty < 1) return { ok: false, reason: `You hold less than one whole share of ${sym}; set its stop in IBKR.` };
  return { ok: true, change: { symbol: sym, qty, to, tif: "GTC" } };
}

/** The IBKR order for a stop change: a sell STOP, sent as a modify (raise) or a new order (set). */
export function ibkrStopOrder(c: StopChange, acctId: string, conid: number, cOID?: string) {
  return { acctId, conid, ...(cOID ? { cOID } : {}), orderType: "STP" as const, side: "SELL" as const, price: cents(c.to), quantity: c.qty, tif: c.tif, outsideRTH: false as const };
}

/** The stop ticket in plain words. */
export function stopTicketLines(c: StopChange, account: string, paper: boolean, f: Pick<StopFacts, "shares" | "avgCost" | "price">): string[] {
  const vsCost = c.qty * (c.to - f.avgCost);
  const costNote = f.avgCost > 0 ? (vsCost >= 0 ? `; $${vsCost.toFixed(2)} over your cost` : `; $${(-vsCost).toFixed(2)} under your cost`) : "";
  const out = [
    `${paper ? "PAPER" : "LIVE"} account ${account}, Interactive Brokers`,
    c.orderId
      ? `CHANGE stop order #${c.orderId}: SELL ${+c.qty.toFixed(4)} ${c.symbol} STOP $${c.from!.toFixed(2)} → $${c.to.toFixed(2)}, ${c.tif === "GTC" ? "good till canceled" : "good for today"}`
      : `NEW SELL ${c.qty} ${c.symbol} STOP $${c.to.toFixed(2)}, good till canceled`,
    `if it fills at $${c.to.toFixed(2)}: $${(c.qty * (f.price - c.to)).toFixed(2)} below today's $${f.price.toFixed(2)}${costNote}`,
    "a stop is an order, not a promise: a gap can fill below it",
  ];
  const left = +(f.shares - c.qty).toFixed(4);
  if (!c.orderId && left > 0) out.push(`${left} fractional share${left === 1 ? "" : "s"} stay without a stop`);
  return out;
}

/** What the user types to send a stop ticket: "STOP TSLA 352.10". */
export const stopConfirm = (c: Pick<StopChange, "symbol" | "to">) => `STOP ${c.symbol.toUpperCase()} ${c.to.toFixed(2)}`;
export const stopConfirmMatches = (typed: string, c: Pick<StopChange, "symbol" | "to">) => (typed ?? "").trim().toUpperCase().replace(/\$/g, "").replace(/\s+/g, " ") === stopConfirm(c);
