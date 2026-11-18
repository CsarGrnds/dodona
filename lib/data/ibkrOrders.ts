// Server only. The ONE place in Dodona that can send orders to Interactive Brokers, through the
// local Client Portal Gateway. It is trader-broker's job, for IBKR, with all of its gates:
//
//   1. Turned on by you: "ibkr_orders": true and "broker": "ibkr" in trader/config.json (Settings).
//   2. Paper unless you say otherwise: while "paper" is true (the default) it only sends to an IBKR
//      paper account (DU…). Turning paper off is yours to do, in the file, never from the page.
//   3. trader-risk PASSED every order in the batch (same fingerprints) in the last 15 minutes, and
//      their losses together fit the day's limit (trader-risk adds them up).
//   4. Never a stock you already hold: a day trade's sell at the close could otherwise touch shares
//      you keep. Never the same order twice in a day.
//   5. Your yes: you type the batch ("8 TSLA, 5 F") and click Place in Dodona. Claude never calls
//      this, from a chat, a skill or a schedule.
//   6. IBKR's own questions are never answered for you: each one comes back to you to confirm.
//
// The morning flow: the trade team (run from the repo root against the real portfolio) stages up to
// a day's trades as buy-STOP brackets, trader-risk checks them together, you approve the batch once,
// and the orders wait at IBKR: each buys only if its breakout triggers, with its stop, target and a
// sell at the close attached. Every step is logged to trader/state/broker.json in trader-broker's
// format, so trader-risk counts what was placed against your daily limits.
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { marketStatus } from "@/lib/clock";
import { confirmMatches, confirmPhrase, entryRef, feeProblem, ibkrBracket, ibkrMoney, ibkrWarning, isPaperAccount, maxLossOf, nyIso, parsePlaceAnswer, ticketLines, type BracketPlan, type PlaceAnswer } from "@/lib/ibkrOrder";
import type { OpenOrder } from "@/lib/prep";
import { nyClock } from "@/lib/setups";
import { configPath } from "./desk";
import { accountId, call, GatewayError, gatewayStatus, openOrders } from "./ibkr";
import { orderFingerprint } from "./paper";

const root = (p: string) => resolve(process.cwd(), "trader", p);
const ORDERS = () => root("orders.json");
const RISK = () => root("state/risk.json");
const BROKER = () => root("state/broker.json");
const MAX_BATCH = 5;
const RISK_MAX_AGE_MIN = 15;

const readJson = async (p: string) => JSON.parse(await readFile(p, "utf8").catch(() => "null"));
async function writeJson(p: string, v: unknown) {
  await mkdir(dirname(p), { recursive: true });
  await writeFile(`${p}.tmp`, JSON.stringify(v, null, 2) + "\n");
  await rename(`${p}.tmp`, p);
}

interface LogRec {
  at: string;
  date: string;
  fingerprint: string;
  symbol: string;
  side: string;
  qty?: string;
  kind?: string;
  max_loss?: number;
  cost?: number; // qty x the entry price it was sized at: what it puts into the trade if it fills
  stop?: number;
  plain?: string;
  status: "approved" | "placed" | "failed" | "declined" | "canceled";
  reply?: string;
  paper?: boolean;
  broker: "ibkr";
  account?: string;
  broker_order_id?: string;
  note?: string;
}

async function log(rec: Omit<LogRec, "at" | "date" | "broker">, nowMs = Date.now()) {
  const state = (await readJson(BROKER())) ?? { orders: [] };
  state.orders = Array.isArray(state.orders) ? state.orders : [];
  state.orders.push({ at: nyIso(nowMs), date: nyClock(nowMs).date, broker: "ibkr", ...rec });
  await writeJson(BROKER(), state);
}

// ---------------------------------------------------------------- the batch trader-risk passed

export interface BatchItem {
  plan: BracketPlan;
  fingerprint: string;
  maxLoss: number;
  lines: string[];
}

/** trader/orders.json + trader/state/risk.json → the orders that may be placed, or why not. Pure. */
export function acceptBatch(ordersDoc: unknown, riskDoc: unknown, nowMs: number): { ok: true; items: Array<Omit<BatchItem, "lines">> } | { ok: false; reason: string } {
  const orders = ((ordersDoc as { orders?: Array<Record<string, unknown>> } | null)?.orders ?? []) as Array<Record<string, unknown>>;
  const rd = riskDoc as { checked_at?: string; results?: Array<{ fingerprint?: string; verdict?: string; reasons?: string[] }> } | null;
  if (!orders.length) return { ok: false, reason: "trader/orders.json has no orders" };
  if (orders.length > MAX_BATCH) return { ok: false, reason: `${orders.length} orders: at most ${MAX_BATCH} at once` };
  if (!rd?.checked_at || !Array.isArray(rd.results)) return { ok: false, reason: "no trader-risk check found (run /trader-risk on these orders)" };
  const age = (nowMs - Date.parse(rd.checked_at)) / 60_000;
  if (!(age >= -1 && age <= RISK_MAX_AGE_MIN)) return { ok: false, reason: `the risk check is ${Math.round(age)} minutes old; run /trader-risk again` };
  const items: Array<Omit<BatchItem, "lines">> = [];
  const seen = new Set<string>();
  for (const o of orders) {
    const sym = String(o.symbol ?? "").toUpperCase();
    if (String(o.side).toLowerCase() !== "buy") return { ok: false, reason: `${sym}: only buys (entries with a bracket) can be placed from here` };
    if (o.order_class !== "bracket") return { ok: false, reason: `${sym}: not a bracket order: a stop-loss and take-profit are required` };
    if (seen.has(sym)) return { ok: false, reason: `${sym} is in the batch twice` };
    seen.add(sym);
    const fp = orderFingerprint(o);
    const r = rd.results.find((x) => x.fingerprint === fp);
    if (!r) return { ok: false, reason: `${sym}: trader-risk checked a different order than the one in orders.json` };
    if (r.verdict !== "PASS") return { ok: false, reason: `${sym}: trader-risk said ${r.verdict}: ${(r.reasons ?? []).join("; ")}` };
    const plan = (o.plan ?? {}) as Record<string, unknown>;
    const type = String(o.type ?? "market").toLowerCase();
    const qty = Number(o.qty), stop = Number(o.stop_loss_stop_price), target = Number(o.take_profit_limit_price), entry = Number(plan.entry);
    if (!(qty > 0) || !(stop > 0) || !(target > 0) || !(entry > 0)) return { ok: false, reason: `${sym}: missing qty, stop, target or the plan's entry` };
    if (!["market", "limit", "stop"].includes(type)) return { ok: false, reason: `${sym}: a ${type} entry isn't supported (market, limit or stop)` };
    const trigger = type === "stop" ? Number(o.stop_price) : undefined;
    const limit = type === "limit" ? Number(o.limit_price) : undefined;
    if (trigger !== undefined && !(trigger > 0)) return { ok: false, reason: `${sym}: a stop entry needs its stop_price (the trigger)` };
    const p: BracketPlan = { symbol: sym, qty, stop, target, entry, ...(trigger ? { trigger } : {}), ...(limit ? { limit } : {}), closeAtEnd: String(plan.style ?? "day") !== "swing" };
    items.push({ plan: p, fingerprint: fp, maxLoss: maxLossOf(p) });
  }
  return { ok: true, items };
}

export interface IbkrTicket {
  ready: boolean;
  problems: string[]; // why it can't be placed now, in plain words
  items: BatchItem[];
  totalMaxLoss: number;
  dailyLimit?: number;
  batchCost: number; // what the batch puts into trades if every order fills
  spendable?: number; // the budget minus the cash buffer
  confirm?: string; // what to type to place them
  account?: string;
  accountIsPaper?: boolean;
  paperOnly: boolean;
  enabled: boolean;
  gateway: "down" | "login" | "ready";
}

async function heldSymbols(account: string): Promise<Set<string>> {
  const out = new Set<string>();
  const a = encodeURIComponent(account);
  for (let page = 0; page < 10; page++) {
    const rows = await call<Array<Record<string, unknown>>>("GET", `/v1/api/portfolio/${a}/positions/${page}`).catch(() => []);
    if (!Array.isArray(rows) || !rows.length) break;
    for (const r of rows) if (Number(r.position) !== 0) out.add(String(r.ticker ?? r.contractDesc ?? "").toUpperCase());
    if (rows.length < 100) break;
  }
  return out;
}

export async function ibkrTicket(nowMs = Date.now()): Promise<IbkrTicket> {
  const cfg = ((await readJson(configPath())) ?? {}) as Record<string, unknown>;
  const paperOnly = cfg.paper !== false;
  const enabled = cfg.ibkr_orders === true && String(cfg.broker ?? "").toLowerCase() === "ibkr";
  const problems: string[] = [];
  if (String(cfg.broker ?? "").toLowerCase() !== "ibkr") problems.push(`Your broker is set to "${cfg.broker ?? "alpaca"}"; set it to IBKR in Settings.`);
  if (cfg.ibkr_orders !== true) problems.push("Sending orders to IBKR is off; turn it on in Settings.");

  const gw = await gatewayStatus();
  let account: string | undefined;
  if (gw.state !== "ready") problems.push(gw.state === "login" ? "Log in to the IBKR gateway (say “refresh IBKR” in Claude Code)." : `The IBKR gateway isn't running (${gw.message ?? "down"}).`);
  else {
    account = gw.account ?? (await accountId().catch(() => undefined));
    if (!account) problems.push("The gateway returned no account.");
    else if (paperOnly && !isPaperAccount(account)) problems.push(`Paper trading is on, so orders only go to a paper account, but the gateway is logged in to a live account (…${account.slice(-3)}). For real orders, set "paper": false in trader/config.json yourself; for paper orders, log in with your paper username.`);
  }

  const doc = await readJson(ORDERS());
  const acc = doc ? acceptBatch(doc, await readJson(RISK()), nowMs) : undefined;
  let items: BatchItem[] = [];
  if (!doc) problems.push("No orders waiting: the trade team's morning run (or /trader-budget and /trader-risk) writes them.");
  else if (!acc!.ok) problems.push(acc!.reason);
  else {
    items = acc!.items.map((x) => ({ ...x, lines: ticketLines(x.plan, account ?? "(not connected)", account ? isPaperAccount(account) : paperOnly).slice(1) }));
    const today = nyClock(nowMs).date;
    const st = await readJson(BROKER());
    for (const it of items) {
      const hit = ((st?.orders ?? []) as LogRec[]).find((r) => r.fingerprint === it.fingerprint && r.date === today && r.broker === "ibkr" && (r.status === "placed" || r.status === "approved"));
      if (hit) problems.push(`${it.plan.symbol}: this exact order was already sent today (${hit.status} at ${hit.at.slice(11, 16)}); it is never sent twice.`);
    }
    for (const it of items) {
      const fee = feeProblem(it.plan, Number(cfg.max_fee_pct) > 0 ? Number(cfg.max_fee_pct) / 100 : undefined);
      if (fee) problems.push(fee);
    }
    if (account) {
      const held = await heldSymbols(account);
      for (const it of items) if (held.has(it.plan.symbol)) problems.push(`${it.plan.symbol}: you already hold it. Day trades are only placed in stocks you don't hold, so a sell can never touch shares you keep.`);
    }
  }
  if (!marketStatus(nowMs).open) problems.push("The market is closed: orders are only sent while it is open.");
  const totalMaxLoss = Math.round(items.reduce((a, x) => a + x.maxLoss, 0) * 100) / 100;
  const dailyLimit = Number(cfg.max_daily_loss_usd) || undefined;
  if (dailyLimit && totalMaxLoss > dailyLimit + 0.005) problems.push(`Together these risk $${totalMaxLoss.toFixed(2)}, over your $${dailyLimit.toFixed(2)} daily limit.`);
  // never more money in trades than the budget allows: this batch plus what was placed earlier today
  const budget = Number(cfg.budget);
  const spendable = budget > 0 ? Math.round(budget * (1 - (Number(cfg.cash_buffer_pct) || 0) / 100) * 100) / 100 : undefined;
  const batchCost = Math.round(items.reduce((a, x) => a + x.plan.qty * entryRef(x.plan), 0) * 100) / 100;
  const st2 = await readJson(BROKER());
  const placedToday = Math.round(((st2?.orders ?? []) as LogRec[]).filter((r) => r.broker === "ibkr" && r.date === nyClock(nowMs).date && r.status === "placed").reduce((a, r) => a + (r.cost ?? 0), 0) * 100) / 100;
  if (spendable !== undefined && items.length && batchCost + placedToday > spendable + 0.005)
    problems.push(`Together these cost $${batchCost.toFixed(2)}${placedToday ? ` (plus $${placedToday.toFixed(2)} placed earlier today)` : ""}, over the $${spendable.toFixed(2)} your budget allows ($${budget.toFixed(0)} minus the ${cfg.cash_buffer_pct ?? 0}% cash buffer).`);

  return {
    ready: problems.length === 0 && items.length > 0,
    problems,
    items,
    totalMaxLoss,
    dailyLimit,
    batchCost,
    spendable,
    confirm: items.length ? confirmPhrase(items.map((x) => x.plan)) : undefined,
    account,
    accountIsPaper: account ? isPaperAccount(account) : undefined,
    paperOnly,
    enabled,
    gateway: gw.state,
  };
}

async function conidFor(symbol: string): Promise<number> {
  const res = await call<Record<string, Array<{ contracts?: Array<{ conid?: number; isUS?: boolean }> }>>>("GET", `/v1/api/trsrv/stocks?symbols=${encodeURIComponent(symbol)}`);
  const contracts = (res?.[symbol] ?? []).flatMap((x) => x.contracts ?? []);
  const c = contracts.find((x) => x.isUS && x.conid) ?? contracts.find((x) => x.conid);
  if (!c?.conid) throw new GatewayError("error", `IBKR doesn't know the stock ${symbol}`);
  return c.conid;
}

// ---------------------------------------------------------------- preview (places nothing)

export interface IbkrPreview {
  symbol: string;
  commission?: number;
  cost?: number;
  total?: number;
  warn?: string;
  error?: string;
}

/** IBKR's what-if for every bracket in the batch: cost, commission, warnings. Nothing is placed. */
export async function previewTicket(): Promise<IbkrPreview[]> {
  const t = await ibkrTicket();
  if (!t.items.length || !t.account) throw new Error(t.problems[0] ?? "Nothing to preview");
  await call("GET", "/v1/api/iserver/accounts").catch(() => undefined);
  const out: IbkrPreview[] = [];
  for (const it of t.items) {
    try {
      const conid = await conidFor(it.plan.symbol);
      const r = await call<Record<string, unknown>>("POST", `/v1/api/iserver/account/${encodeURIComponent(t.account)}/orders/whatif`, 20_000, { orders: ibkrBracket(it.plan, t.account, conid, "preview") });
      const amt = (r.amount ?? {}) as Record<string, unknown>;
      out.push({ symbol: it.plan.symbol, commission: ibkrMoney(amt.commission), cost: ibkrMoney(amt.amount), total: ibkrMoney(amt.total), warn: ibkrWarning(r.warn), error: r.error ? String(r.error) : undefined });
    } catch (e) {
      out.push({ symbol: it.plan.symbol, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}

// ---------------------------------------------------------------- place, only on your click

interface Ctx {
  fingerprint: string;
  plan: BracketPlan;
  account: string;
  paper: boolean;
}
// the batch being placed (what's left of it) and IBKR's open questions, so only those ids can be answered
const g = globalThis as unknown as { __dodonaIbkr?: { pending: Map<string, Ctx & { at: number }>; queue: Ctx[]; busy: boolean } };
const S = (g.__dodonaIbkr ??= { pending: new Map(), queue: [] as Ctx[], busy: false });

export interface PlaceResult {
  ok: boolean;
  placed: Array<{ symbol: string; orderIds: string[] }>;
  questions: Array<{ id: string; symbol: string; messages: string[] }>;
  failed: Array<{ symbol: string; error: string }>;
  note: string;
}

async function finish(ans: PlaceAnswer, ctx: Ctx, res: PlaceResult) {
  const base = { fingerprint: ctx.fingerprint, symbol: ctx.plan.symbol, side: "buy", qty: String(ctx.plan.qty), kind: "entry", plain: ticketLines(ctx.plan, ctx.account, ctx.paper)[1], paper: ctx.paper, account: ctx.account };
  if (ans.error) {
    await log({ ...base, status: "failed", note: ans.error });
    res.failed.push({ symbol: ctx.plan.symbol, error: ans.error });
    return;
  }
  for (const q of ans.questions) {
    S.pending.set(q.id, { ...ctx, at: Date.now() });
    res.questions.push({ id: q.id, symbol: ctx.plan.symbol, messages: q.messages });
  }
  if (ans.placed.length) {
    await log({ ...base, status: "placed", max_loss: maxLossOf(ctx.plan), cost: Math.round(ctx.plan.qty * entryRef(ctx.plan) * 100) / 100, stop: ctx.plan.stop, broker_order_id: ans.placed.map((p) => p.orderId).join(",") });
    res.placed.push({ symbol: ctx.plan.symbol, orderIds: ans.placed.map((p) => p.orderId) });
  }
}

/** Send the queue in order; stop at the first bracket IBKR has a question about (it goes to you). */
async function drain(res: PlaceResult) {
  while (S.queue.length && !res.questions.length) {
    const ctx = S.queue.shift()!;
    try {
      const conid = await conidFor(ctx.plan.symbol);
      const cOID = `dodona-${createHash("sha256").update(`${ctx.fingerprint}:${Date.now()}`).digest("hex").slice(0, 12)}`;
      const raw = await call<unknown>("POST", `/v1/api/iserver/account/${encodeURIComponent(ctx.account)}/orders`, 20_000, { orders: ibkrBracket(ctx.plan, ctx.account, conid, cOID) });
      await finish(parsePlaceAnswer(raw), ctx, res);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      await log({ fingerprint: ctx.fingerprint, symbol: ctx.plan.symbol, side: "buy", status: "failed", note: error, account: ctx.account, paper: ctx.paper });
      res.failed.push({ symbol: ctx.plan.symbol, error });
    }
  }
  if (!S.queue.length && !res.questions.length && !S.pending.size) {
    // the whole batch is done: it can't be sent again; the next one needs a new team run and risk check
    await rename(ORDERS(), root(`orders-sent-${new Date().toISOString().replace(/[:.]/g, "-")}.json`)).catch(() => undefined);
  }
  const waiting = S.queue.length;
  res.note = `${res.placed.length ? `Sent to IBKR: ${res.placed.map((p) => p.symbol).join(", ")}. ` : ""}${res.questions.length ? "IBKR asks you to confirm first." : ""}${waiting ? ` ${waiting} more after that.` : ""}${res.failed.length ? ` Failed: ${res.failed.map((f) => f.symbol).join(", ")}.` : ""}`.trim();
}

/** Place the batch. Only from Dodona's page, after the user typed the confirmation and clicked. */
export async function placeTicket(input: { fingerprints: string[]; typed: string }): Promise<PlaceResult> {
  const res: PlaceResult = { ok: false, placed: [], questions: [], failed: [], note: "" };
  if (S.busy || S.queue.length || S.pending.size) return { ...res, note: "A batch is already being sent; answer IBKR's questions or wait." };
  S.busy = true;
  try {
    const t = await ibkrTicket(); // every gate, again, right now
    if (!t.ready || !t.account) return { ...res, note: t.problems[0] ?? "Not ready" };
    const fps = t.items.map((x) => x.fingerprint);
    if (fps.length !== input.fingerprints.length || fps.some((f, i) => f !== input.fingerprints[i])) return { ...res, note: "The orders changed since you looked at them. Look at the new tickets first." };
    if (!confirmMatches(input.typed ?? "", t.items.map((x) => x.plan))) return { ...res, note: `Type ${t.confirm} to confirm.` };
    const paper = isPaperAccount(t.account);
    for (const it of t.items) {
      await log({ fingerprint: it.fingerprint, symbol: it.plan.symbol, side: "buy", qty: String(it.plan.qty), kind: "entry", plain: it.lines[0], status: "approved", reply: `typed "${input.typed.trim()}" and clicked Place in Dodona`, paper, account: t.account });
      S.queue.push({ fingerprint: it.fingerprint, plan: it.plan, account: t.account, paper });
    }
    await call("GET", "/v1/api/iserver/accounts").catch(() => undefined);
    await drain(res);
    res.ok = !res.failed.length;
    return res;
  } finally {
    S.busy = false;
  }
}

/** The user's answer to one of IBKR's questions; then the rest of the batch continues. */
export async function answerQuestion(input: { id: string; confirmed: boolean }): Promise<PlaceResult> {
  const res: PlaceResult = { ok: false, placed: [], questions: [], failed: [], note: "" };
  const ctx = S.pending.get(input.id);
  if (!ctx || Date.now() - ctx.at > 5 * 60_000) {
    S.pending.delete(input.id);
    return { ...res, note: "That question has expired. Look at the tickets again." };
  }
  S.pending.delete(input.id);
  if (S.busy) return { ...res, note: "Busy; try again in a moment." };
  S.busy = true;
  try {
    if (!input.confirmed) {
      await call("POST", `/v1/api/iserver/reply/${encodeURIComponent(input.id)}`, 10_000, { confirmed: false }).catch(() => undefined);
      await log({ fingerprint: ctx.fingerprint, symbol: ctx.plan.symbol, side: "buy", status: "declined", reply: "said no to IBKR's question", account: ctx.account, paper: ctx.paper });
      res.note = `${ctx.plan.symbol} not placed.`;
    } else {
      await finish(parsePlaceAnswer(await call<unknown>("POST", `/v1/api/iserver/reply/${encodeURIComponent(input.id)}`, 20_000, { confirmed: true })), ctx, res);
    }
    if (!res.questions.length) await drain(res);
    res.ok = !res.failed.length;
    return res;
  } finally {
    S.busy = false;
  }
}

/** Stop sending the rest of a batch (what's already at IBKR stays). */
export function abandonBatch(): number {
  const n = S.queue.length + S.pending.size;
  S.queue = [];
  S.pending.clear();
  return n;
}

// ---------------------------------------------------------------- cancel today's unfilled entries

/**
 * Cancel the buy orders Dodona placed today that haven't filled yet (their stop, target and close
 * orders go with them). Positions that already filled keep their stop and target at IBKR.
 */
export async function cancelUnfilled(nowMs = Date.now()): Promise<{ canceled: string[]; failed: string[] }> {
  const st = await readJson(BROKER());
  const today = nyClock(nowMs).date;
  const ours = new Map<string, LogRec>();
  for (const r of ((st?.orders ?? []) as LogRec[]).filter((r) => r.broker === "ibkr" && r.date === today && r.status === "placed" && r.broker_order_id)) for (const id of r.broker_order_id!.split(",")) ours.set(id, r);
  const open = await openOrders();
  const canceled: string[] = [], failed: string[] = [];
  for (const o of open.filter((o) => o.side === "BUY" && ours.has(o.orderId))) {
    const r = ours.get(o.orderId)!;
    try {
      await call("DELETE", `/v1/api/iserver/account/${encodeURIComponent(r.account ?? (await accountId()))}/order/${encodeURIComponent(o.orderId)}`);
      await log({ fingerprint: r.fingerprint, symbol: r.symbol, side: "buy", status: "canceled", broker_order_id: o.orderId, account: r.account, paper: r.paper, reply: "clicked Cancel unfilled in Dodona" });
      canceled.push(r.symbol);
    } catch {
      failed.push(r.symbol);
    }
  }
  return { canceled, failed };
}

// ---------------------------------------------------------------- what happened at IBKR (read-only)

export interface IbkrActivity {
  open: OpenOrder[];
  trades: Array<{ id: string; symbol: string; side: string; qty: number; price: number; at: string; commission?: number }>;
  log: LogRec[]; // today's IBKR records in trader/state/broker.json
  unfilledToday: number; // Dodona's buy orders still waiting at IBKR
}

export async function ibkrActivity(nowMs = Date.now()): Promise<IbkrActivity> {
  const open = await openOrders().catch(() => [] as OpenOrder[]);
  const raw = await call<Array<Record<string, unknown>>>("GET", "/v1/api/iserver/account/trades").catch(() => []);
  const want = process.env.IBKR_ACCOUNT?.trim();
  const trades = (Array.isArray(raw) ? raw : [])
    .filter((t) => !want || !t.account || t.account === want)
    .map((t) => ({ id: String(t.execution_id ?? ""), symbol: String(t.symbol ?? ""), side: String(t.side ?? "").toUpperCase().startsWith("B") ? "BUY" : "SELL", qty: Number(t.size ?? 0), price: Number(t.price ?? 0), at: String(t.trade_time_r ? new Date(Number(t.trade_time_r)).toISOString() : t.trade_time ?? ""), commission: t.commission !== undefined ? Number(t.commission) : undefined }));
  const st = await readJson(BROKER());
  const today = nyClock(nowMs).date;
  const log = ((st?.orders ?? []) as LogRec[]).filter((r) => r.broker === "ibkr" && r.date === today);
  const ids = new Set(log.filter((r) => r.status === "placed").flatMap((r) => (r.broker_order_id ?? "").split(",")));
  return { open, trades, log, unfilledToday: open.filter((o) => o.side === "BUY" && ids.has(o.orderId)).length };
}
