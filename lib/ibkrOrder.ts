// Pure: turning trader-budget's one bracket order (Alpaca's shape, checked by trader-risk) into
// Interactive Brokers' Client Portal Web API orders, and reading what IBKR answers.
//
// An IBKR bracket is three orders sent together: the parent (the buy) and two children that name
// it as their parentId: a take-profit limit sell and a stop-loss stop sell. IBKR links the children
// so one cancels the other, and only works them once the parent fills.

export interface BracketPlan {
  symbol: string;
  qty: number;
  stop: number;
  target: number;
  entry: number; // the plan's entry, for the max loss
  limit?: number; // a limit entry; market when absent
}

export interface IbkrOrder {
  acctId: string;
  conid: number;
  cOID: string;
  parentId?: string;
  orderType: "MKT" | "LMT" | "STP";
  side: "BUY" | "SELL";
  quantity: number;
  price?: number;
  tif: "DAY";
  outsideRTH: false;
}

/** IBKR paper accounts start with D (DU1234567); live ones with U. */
export const isPaperAccount = (id?: string) => !!id && /^D/i.test(id.trim());

const cents = (n: number) => Math.round(n * 100) / 100;

export function ibkrBracket(p: BracketPlan, acctId: string, conid: number, cOID: string): IbkrOrder[] {
  if (!(p.qty > 0) || !Number.isInteger(p.qty)) throw new Error("whole shares only");
  if (!(p.stop > 0 && p.target > p.stop)) throw new Error("the stop must be below the target");
  if (p.limit !== undefined && !(p.limit > p.stop && p.limit < p.target)) throw new Error("the limit must sit between the stop and the target");
  const base = { acctId, conid, quantity: p.qty, tif: "DAY" as const, outsideRTH: false as const };
  return [
    { ...base, cOID, side: "BUY", ...(p.limit !== undefined ? { orderType: "LMT" as const, price: cents(p.limit) } : { orderType: "MKT" as const }) },
    { ...base, cOID: `${cOID}-tp`, parentId: cOID, side: "SELL", orderType: "LMT", price: cents(p.target) },
    { ...base, cOID: `${cOID}-sl`, parentId: cOID, side: "SELL", orderType: "STP", price: cents(p.stop) },
  ];
}

/** The ticket in plain words, as trader-broker shows it. */
export function ticketLines(p: BracketPlan, account: string, paper: boolean): string[] {
  const risk = Math.max(p.entry, p.limit ?? 0) - p.stop;
  return [
    `${paper ? "PAPER" : "LIVE"} account ${account}, Interactive Brokers`,
    `BUY ${p.qty} ${p.symbol}, ${p.limit !== undefined ? `limit $${p.limit.toFixed(2)}` : "market"}, good for today`,
    `stop-loss $${p.stop.toFixed(2)} · take-profit $${p.target.toFixed(2)} (one cancels the other)`,
    `max loss about $${cents(p.qty * risk).toFixed(2)} if the stop fills at $${p.stop.toFixed(2)}; in a fast market it can fill worse`,
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

/** What the user must type to place it: the quantity and the symbol, e.g. "8 TSLA". */
export const confirmPhrase = (p: { qty: number; symbol: string }) => `${p.qty} ${p.symbol.toUpperCase()}`;
export const confirmMatches = (typed: string, p: { qty: number; symbol: string }) => typed.trim().replace(/\s+/g, " ").toUpperCase() === confirmPhrase(p);

/** IBKR writes money as text: "11.36 USD (1 Shares)", "1,234.50 USD". The first number is the amount. */
export function ibkrMoney(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  const m = String(v ?? "").match(/-?\d[\d,]*(?:\.\d+)?/);
  return m ? Number(m[0].replace(/,/g, "")) : undefined;
}

/** IBKR's warnings come as "20/You are trying to…": drop the code, keep the words. */
export const ibkrWarning = (v: unknown) => (v ? String(v).replace(/^\d+\//, "").replace(/\s+/g, " ").trim() : undefined);
