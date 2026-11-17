// Server only. The ONE place in Dodona that can send an order to Interactive Brokers, through the
// local Client Portal Gateway. It is trader-broker's job, for IBKR, and keeps all of its gates:
//
//   1. Turned on by you: "ibkr_orders": true and "broker": "ibkr" in trader/config.json (Settings).
//   2. Paper unless you say otherwise: while "paper" is true (the default) it only sends to an IBKR
//      paper account (DU…). Turning paper off is yours to do, in the file, never from the page.
//   3. trader-risk PASSED this exact order (same fingerprint) in the last 15 minutes.
//   4. Your yes: you type the quantity and symbol ("8 TSLA") and click Place in Dodona. Claude never
//      calls this, from a chat, a skill or a schedule.
//   5. IBKR's own questions are never answered for you: each one comes back to you to confirm.
//
// It only ever sends the one bracket in trader/orders.json (repo root: the real-account pipeline
// trader-budget → trader-risk → here), once. Every step is logged to trader/state/broker.json in
// trader-broker's format, so trader-risk counts what was placed against your daily limits.
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { marketStatus } from "@/lib/clock";
import { confirmMatches, confirmPhrase, ibkrBracket, ibkrMoney, ibkrWarning, isPaperAccount, nyIso, parsePlaceAnswer, ticketLines, type BracketPlan, type PlaceAnswer } from "@/lib/ibkrOrder";
import type { OpenOrder } from "@/lib/prep";
import { nyClock } from "@/lib/setups";
import { configPath } from "./desk";
import { accountId, call, GatewayError, gatewayStatus, openOrders } from "./ibkr";
import { acceptTeamOrder, orderFingerprint } from "./paper";

const root = (p: string) => resolve(process.cwd(), "trader", p);
const ORDERS = () => root("orders.json");
const RISK = () => root("state/risk.json");
const BROKER = () => root("state/broker.json");

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
  stop?: number;
  plain?: string;
  status: "approved" | "placed" | "failed" | "declined";
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

// ---------------------------------------------------------------- the ticket and its gates

export interface IbkrTicket {
  ready: boolean;
  problems: string[]; // why it can't be placed now, in plain words
  plan?: BracketPlan;
  fingerprint?: string;
  lines?: string[];
  confirm?: string; // what to type to place it
  account?: string;
  accountIsPaper?: boolean;
  paperOnly: boolean;
  enabled: boolean;
  gateway: "down" | "login" | "ready";
}

async function config(): Promise<Record<string, unknown>> {
  return (await readJson(configPath())) ?? {};
}

export async function ibkrTicket(nowMs = Date.now()): Promise<IbkrTicket> {
  const cfg = await config();
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
    else if (paperOnly && !isPaperAccount(account)) problems.push(`Paper trading is on, but the gateway is logged in to ${account}, a live account. Log in with your IBKR paper account (it starts with DU).`);
  }

  const doc = await readJson(ORDERS());
  const acc = acceptTeamOrder(doc, await readJson(RISK()), nowMs);
  let plan: BracketPlan | undefined;
  let fingerprint: string | undefined;
  if (!doc) problems.push("No order to place: run /trader-budget (it writes trader/orders.json) and /trader-risk.");
  else if (!acc.ok) problems.push(acc.reason.replace("the desk books exactly one", "exactly one order can be placed").replace("the desk only books buys from the team; exits are handled by the desk", "only buys (entries with a bracket) can be placed from here"));
  else {
    const o = (doc as { orders: Array<Record<string, unknown>> }).orders[0];
    fingerprint = orderFingerprint(o);
    const limit = String(o.type) === "limit" ? Number(o.limit_price) : undefined;
    plan = { symbol: acc.order.symbol, qty: acc.order.qty, stop: acc.order.stop, target: acc.order.target, entry: acc.order.entry, ...(limit && limit > 0 ? { limit } : {}) };
    const done = await sentToday(fingerprint, nowMs);
    if (done) problems.push(`This exact order was already sent to IBKR today (${done}). It is never sent twice.`);
  }
  if (!marketStatus(nowMs).open) problems.push("The market is closed: orders are only sent while it is open.");

  return {
    ready: problems.length === 0,
    problems,
    plan,
    fingerprint,
    lines: plan && account ? ticketLines(plan, account, isPaperAccount(account)) : plan ? ticketLines(plan, "(not connected)", paperOnly) : undefined,
    confirm: plan ? confirmPhrase(plan) : undefined,
    account,
    accountIsPaper: account ? isPaperAccount(account) : undefined,
    paperOnly,
    enabled,
    gateway: gw.state,
  };
}

async function sentToday(fp: string, nowMs: number): Promise<string | undefined> {
  const st = await readJson(BROKER());
  const today = nyClock(nowMs).date;
  const hit = ((st?.orders ?? []) as LogRec[]).find((r) => r.fingerprint === fp && r.date === today && r.broker === "ibkr" && (r.status === "placed" || r.status === "approved"));
  return hit ? `${hit.status} at ${hit.at.slice(11, 16)}` : undefined;
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
  commission?: number;
  cost?: number;
  total?: number;
  equityAfter?: string;
  initialMargin?: string;
  warn?: string;
  error?: string;
}

/** IBKR's what-if for the buy: what it would cost and what IBKR warns about. Nothing is placed. */
export async function previewTicket(): Promise<IbkrPreview> {
  const t = await ibkrTicket();
  if (!t.plan || !t.account) throw new Error(t.problems[0] ?? "Nothing to preview");
  await call("GET", "/v1/api/iserver/accounts").catch(() => undefined);
  const conid = await conidFor(t.plan.symbol);
  const [parent] = ibkrBracket(t.plan, t.account, conid, "preview");
  const r = await call<Record<string, unknown>>("POST", `/v1/api/iserver/account/${encodeURIComponent(t.account)}/orders/whatif`, 15_000, { orders: [parent] });
  const amt = (r.amount ?? {}) as Record<string, unknown>;
  const after = (k: string) => ((r[k] ?? {}) as Record<string, unknown>).after as string | undefined;
  return { commission: ibkrMoney(amt.commission), cost: ibkrMoney(amt.amount), total: ibkrMoney(amt.total), equityAfter: after("equity"), initialMargin: after("initial"), warn: ibkrWarning(r.warn), error: r.error ? String(r.error) : undefined };
}

// ---------------------------------------------------------------- place, only on your click

// IBKR's open questions for an order being placed, so only those ids can be answered
const g = globalThis as unknown as { __dodonaIbkrPending?: Map<string, { fingerprint: string; plan: BracketPlan; account: string; paper: boolean; at: number }>; __dodonaIbkrBusy?: boolean };
const pending = (g.__dodonaIbkrPending ??= new Map());

export type PlaceResult = { ok: true; placed: PlaceAnswer["placed"]; questions: PlaceAnswer["questions"]; note: string } | { ok: false; error: string };

async function finish(ans: PlaceAnswer, ctx: { fingerprint: string; plan: BracketPlan; account: string; paper: boolean }): Promise<PlaceResult> {
  const plain = `BUY ${ctx.plan.qty} ${ctx.plan.symbol} bracket, stop ${ctx.plan.stop}, target ${ctx.plan.target}`;
  const base = { fingerprint: ctx.fingerprint, symbol: ctx.plan.symbol, side: "buy", qty: String(ctx.plan.qty), kind: "entry", plain, paper: ctx.paper, account: ctx.account };
  if (ans.error) {
    await log({ ...base, status: "failed", note: ans.error });
    return { ok: false, error: `IBKR refused it: ${ans.error}` };
  }
  for (const q of ans.questions) pending.set(q.id, { ...ctx, at: Date.now() });
  if (ans.placed.length) {
    const risk = Math.max(ctx.plan.entry, ctx.plan.limit ?? 0) - ctx.plan.stop;
    await log({ ...base, status: "placed", max_loss: Math.round(ctx.plan.qty * risk * 100) / 100, stop: ctx.plan.stop, broker_order_id: ans.placed.map((p) => p.orderId).join(",") });
    // it can't be sent again: the next order needs a new trader-budget and trader-risk run
    await rename(ORDERS(), root(`orders-sent-${new Date().toISOString().replace(/[:.]/g, "-")}.json`)).catch(() => undefined);
    return { ok: true, placed: ans.placed, questions: [], note: `Sent to IBKR ${ctx.paper ? "paper" : "LIVE"} account ${ctx.account}.` };
  }
  return { ok: true, placed: [], questions: ans.questions, note: "IBKR asks you to confirm first." };
}

/** Place the ticket. Only from Dodona's page, after the user typed the confirmation and clicked. */
export async function placeTicket(input: { fingerprint: string; typed: string }): Promise<PlaceResult> {
  if (g.__dodonaIbkrBusy) return { ok: false, error: "An order is already being sent." };
  g.__dodonaIbkrBusy = true;
  try {
    const t = await ibkrTicket(); // every gate, again, right now
    if (!t.ready || !t.plan || !t.fingerprint || !t.account) return { ok: false, error: t.problems[0] ?? "Not ready" };
    if (input.fingerprint !== t.fingerprint) return { ok: false, error: "The order changed since you looked at it. Look at the new ticket first." };
    if (!confirmMatches(input.typed ?? "", t.plan)) return { ok: false, error: `Type ${t.confirm} to confirm.` };
    const ctx = { fingerprint: t.fingerprint, plan: t.plan, account: t.account, paper: isPaperAccount(t.account) };
    await log({ fingerprint: t.fingerprint, symbol: t.plan.symbol, side: "buy", qty: String(t.plan.qty), kind: "entry", plain: t.lines?.[1], status: "approved", reply: `typed "${input.typed.trim()}" and clicked Place in Dodona`, paper: ctx.paper, account: t.account });
    await call("GET", "/v1/api/iserver/accounts").catch(() => undefined);
    const conid = await conidFor(t.plan.symbol);
    const cOID = `dodona-${createHash("sha256").update(`${t.fingerprint}:${Date.now()}`).digest("hex").slice(0, 12)}`;
    const raw = await call<unknown>("POST", `/v1/api/iserver/account/${encodeURIComponent(t.account)}/orders`, 20_000, { orders: ibkrBracket(t.plan, t.account, conid, cOID) });
    return finish(parsePlaceAnswer(raw), ctx);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    g.__dodonaIbkrBusy = false;
  }
}

/** The user's answer to one of IBKR's questions about the order being placed. */
export async function answerQuestion(input: { id: string; confirmed: boolean }): Promise<PlaceResult> {
  const ctx = pending.get(input.id);
  if (!ctx || Date.now() - ctx.at > 5 * 60_000) return { ok: false, error: "That question has expired. Start again from the ticket." };
  pending.delete(input.id);
  if (!input.confirmed) {
    await log({ fingerprint: ctx.fingerprint, symbol: ctx.plan.symbol, side: "buy", status: "declined", reply: "said no to IBKR's question", account: ctx.account, paper: ctx.paper });
    await call("POST", `/v1/api/iserver/reply/${encodeURIComponent(input.id)}`, 10_000, { confirmed: false }).catch(() => undefined);
    return { ok: true, placed: [], questions: [], note: "Cancelled. Nothing was placed." };
  }
  const raw = await call<unknown>("POST", `/v1/api/iserver/reply/${encodeURIComponent(input.id)}`, 20_000, { confirmed: true });
  return finish(parsePlaceAnswer(raw), ctx);
}

// ---------------------------------------------------------------- what happened at IBKR (read-only)

export interface IbkrActivity {
  open: OpenOrder[];
  trades: Array<{ id: string; symbol: string; side: string; qty: number; price: number; at: string; commission?: number }>;
  log: LogRec[]; // today's IBKR records in trader/state/broker.json
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
  return { open, trades, log: ((st?.orders ?? []) as LogRec[]).filter((r) => r.broker === "ibkr" && r.date === today) };
}

