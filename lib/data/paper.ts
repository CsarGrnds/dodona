// Server-only: the PAPER workspace the Claude Code trade team runs the /trader-* skills in.
//
// The skills read and write fixed paths relative to where they run (trader/config.json,
// trader/portfolio.json, trader/plan.json, trader/orders.json, trader/state/...). Run from the
// repo root they would size and risk-check against the REAL synced IBKR portfolio. So the team
// runs them with cwd = trader/paper, and this file keeps trader/paper/trader/ in step with the
// paper desk: the same rules, the paper account's cash and positions, and what it placed lately.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { DeskState } from "../desk";
import { configPath } from "./desk";

export const paperRoot = () => resolve(process.cwd(), process.env.DODONA_PAPER_DIR ?? "trader/paper");
export const paperFile = (rel: string) => join(paperRoot(), "trader", rel);

/** trader-broker's state log, rebuilt from the ledger: entries and exits of the last 7 days. */
export function brokerState(s: DeskState, sinceDate: string) {
  const orders: Array<Record<string, unknown>> = [];
  const entry = (p: { symbol: string; qty: number; entry: number; initialStop: number; entryDate: string; openedAt: string }) => ({
    symbol: p.symbol,
    side: "buy",
    kind: "entry",
    status: "placed",
    qty: p.qty,
    date: p.entryDate,
    at: p.openedAt,
    max_loss: Math.round(p.qty * Math.max(0, p.entry - p.initialStop) * 100) / 100,
    source: "dodona paper desk",
  });
  for (const p of s.positions) if (p.entryDate >= sinceDate) orders.push(entry(p));
  for (const t of s.trades) {
    if (t.entryDate >= sinceDate) orders.push(entry(t));
    if (t.exitDate >= sinceDate) orders.push({ symbol: t.symbol, side: "sell", kind: "exit", status: "filled", qty: t.qty, date: t.exitDate, at: t.exitAt, price: t.exit, source: "dodona paper desk" });
  }
  return { note: "Written by Dodona from the paper desk ledger (trader/desk.json). Paper only: nothing here was sent to a broker.", orders };
}

/** The paper account in the shape the skills read (trader-budget, trader-risk, trader-news). */
export function paperPortfolio(s: DeskState) {
  return {
    source: "dodona-paper-desk",
    paper: true,
    syncedAt: new Date().toISOString(),
    currency: "USD",
    cash: s.cash,
    positions: s.positions.map((p) => ({
      ticker: p.symbol,
      shares: p.qty,
      avgCost: p.entry,
      marketPrice: p.lastPrice,
      lots: [{ id: p.id, date: p.entryDate, shares: p.qty, cost: Math.round(p.qty * p.entry * 100) / 100 }],
    })),
  };
}

/** Bring trader/paper/trader/ in step with the ledger and the user's rules. */
export async function writePaperWorkspace(s: DeskState, today: string) {
  await mkdir(join(paperRoot(), "trader", "state"), { recursive: true });
  let config = "{}";
  try {
    config = await readFile(configPath(), "utf8");
  } catch {
    /* the skills fall back to their example rules */
  }
  const cfg = JSON.parse(config);
  cfg.paper = true; // this workspace is paper, whatever the main config says
  const since = new Date(Date.parse(`${today}T12:00:00Z`) - 7 * 86_400_000).toISOString().slice(0, 10);
  await writeFile(paperFile("config.json"), JSON.stringify(cfg, null, 2) + "\n");
  await writeFile(paperFile("portfolio.json"), JSON.stringify(paperPortfolio(s), null, 2) + "\n");
  await writeFile(paperFile("state/broker.json"), JSON.stringify(brokerState(s, since), null, 2) + "\n");
}

// ---------------------------------------------------------------- the team's order, checked

const ALPACA_FIELDS = ["symbol", "side", "qty", "notional", "type", "time_in_force", "limit_price", "stop_price", "trail_price", "trail_percent", "extended_hours", "client_order_id", "order_class", "take_profit_limit_price", "stop_loss_stop_price", "stop_loss_limit_price", "advanced_instructions"];

/** Python's json.dumps(sort_keys=True, separators=(",", ":")), for the values an order holds. */
function pyJson(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return `[${v.map(pyJson).join(",")}]`;
  if (typeof v === "object") return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)}:${pyJson((v as Record<string, unknown>)[k])}`).join(",")}}`;
  if (typeof v === "string") return JSON.stringify(v).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  if (typeof v === "number" && Number.isInteger(v)) return String(v);
  return JSON.stringify(v);
}

/** trader-risk's fingerprint of the exact order it checked (check.py fingerprint()). */
export function orderFingerprint(order: Record<string, unknown>): string {
  const core: Record<string, unknown> = {};
  for (const k of ALPACA_FIELDS) if (k in order && order[k] !== null && order[k] !== undefined) core[k] = order[k];
  return createHash("sha256").update(pyJson(core)).digest("hex").slice(0, 16);
}

export interface TeamOrder {
  symbol: string;
  qty: number;
  stop: number;
  target: number;
  entry: number; // the plan's entry
  setup?: string;
  flatBy?: string;
  maxLoss?: number;
  why?: string;
}

/**
 * The one bracket order trader-budget wrote, accepted only if trader-risk PASSED that exact order
 * (same fingerprint) within the last `maxAgeMin` minutes.
 */
export function acceptTeamOrder(ordersDoc: unknown, riskDoc: unknown, nowMs: number, maxAgeMin = 15): { ok: true; order: TeamOrder } | { ok: false; reason: string } {
  const od = ordersDoc as { orders?: Array<Record<string, unknown>> } | null;
  const rd = riskDoc as { checked_at?: string; results?: Array<{ fingerprint?: string; verdict?: string; reasons?: string[] }> } | null;
  const orders = od?.orders ?? [];
  if (orders.length !== 1) return { ok: false, reason: `orders.json has ${orders.length} orders; the desk books exactly one` };
  const o = orders[0];
  if (String(o.side).toLowerCase() !== "buy") return { ok: false, reason: "the desk only books buys from the team; exits are handled by the desk" };
  if (o.order_class !== "bracket") return { ok: false, reason: "not a bracket order: a stop-loss and take-profit are required" };
  if (!rd?.checked_at || !Array.isArray(rd.results)) return { ok: false, reason: "no trader-risk check found (run /trader-risk on this order)" };
  const age = (nowMs - Date.parse(rd.checked_at)) / 60_000;
  if (!(age >= -1 && age <= maxAgeMin)) return { ok: false, reason: `the risk check is ${Math.round(age)} minutes old; run /trader-risk again` };
  const fp = orderFingerprint(o);
  const r = rd.results.find((x) => x.fingerprint === fp);
  if (!r) return { ok: false, reason: "trader-risk checked a different order than the one in orders.json" };
  if (r.verdict !== "PASS") return { ok: false, reason: `trader-risk said ${r.verdict}: ${(r.reasons ?? []).join("; ")}` };
  const plan = (o.plan ?? {}) as Record<string, unknown>;
  const qty = Number(o.qty);
  const stop = Number(o.stop_loss_stop_price);
  const target = Number(o.take_profit_limit_price);
  const entry = Number(plan.entry);
  if (!(qty > 0) || !(stop > 0) || !(target > 0) || !(entry > 0)) return { ok: false, reason: "the order is missing qty, stop, target or the plan's entry" };
  return { ok: true, order: { symbol: String(o.symbol).toUpperCase(), qty, stop, target, entry, setup: plan.setup ? String(plan.setup) : undefined, flatBy: plan.flat_by ? String(plan.flat_by) : undefined, maxLoss: Number(plan.max_loss) || undefined, why: o.why ? String(o.why) : undefined } };
}
