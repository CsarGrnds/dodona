// The paper desk from the command line, for the Claude Code trade team (/trade-desk).
// PAPER ONLY: nothing here talks to a broker. Every command prints JSON.
//
//   npm run desk -- prep                         mark positions, run stops/targets/flat-by, refresh trader/paper/
//   npm run desk -- status                       the paper account, no changes
//   npm run desk -- book --style day --thesis "…"  book trader/paper/trader/orders.json, only if trader-risk PASSED it
//   npm run desk -- stop --symbol F --price 12.1 --why "…"   raise a paper stop (never lower)
//   npm run desk -- close --symbol F --why "…"   close a paper position at the live price
//   npm run desk -- session start --trigger "…"  open a team session (shown live in Dodona)
//   npm run desk -- log --agent scanner --title "…" [--text "…"]   add a step to it
//   npm run desk -- session end --summary "…" [--status done|error]
//   npm run desk -- driver team|auto             who makes entries: the team, or Dodona's own desk
import { rename, readFile } from "node:fs/promises";
import { marketStatus, nextBell } from "../lib/clock";
import {
  buyFill,
  closePosition,
  dailyRoom,
  equityOf,
  feeCheck,
  log,
  markDay,
  minuteOf,
  openPosition,
  raiseStop,
  riskGate,
  SESSIONS_MAX,
  type AgentSession,
  type DeskRules,
  type DeskState,
  type Style,
} from "../lib/desk";
import { getQuote } from "../lib/data";
import { loadOrCreateDesk, readDeskRules, withDeskLock, writeDesk } from "../lib/data/desk";
import { runDesk } from "../lib/data/deskRun";
import { acceptTeamOrder, paperFile, paperRoot, writePaperWorkspace } from "../lib/data/paper";
import { nyClock } from "../lib/setups";

const argv = process.argv.slice(2);
const cmd = argv[0];
const sub = argv[1] && !argv[1].startsWith("--") ? argv[1] : undefined;
const flag = (k: string) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && i + 1 < argv.length && !argv[i + 1].startsWith("--") ? argv[i + 1] : undefined;
};
const out = (o: unknown) => console.log(JSON.stringify(o, null, 2));
class Refused extends Error {}
/** Stop with a JSON error. Thrown, not exited, so the ledger lock is always released first. */
const fail = (msg: string): never => {
  throw new Refused(msg);
};

function account(s: DeskState, rules: DeskRules, nowMs: number) {
  const ms = marketStatus(nowMs);
  const { date, minute } = nyClock(nowMs);
  const bell = nextBell(nowMs);
  const opened = s.positions.filter((p) => p.entryDate === date).length + s.trades.filter((t) => t.entryDate === date).length;
  return {
    paper: true,
    newYork: `${ms.weekday} ${date} ${ms.nowLabel}`,
    market: { open: ms.open, reason: ms.reason, nextBell: `${bell.kind} at ${bell.label} ${bell.weekday}`, minutesToBell: Math.round((bell.at - nowMs) / 60_000) },
    entryWindow: { from: rules.no_entries_before, to: rules.no_entries_after, flatBy: rules.flat_by, openNow: ms.open && minute >= minuteOf(rules.no_entries_before) && minute <= minuteOf(rules.no_entries_after) },
    cash: s.cash,
    equity: equityOf(s),
    startCash: s.startCash,
    tradesToday: opened,
    tradesLeftToday: Math.max(0, rules.max_trades_per_day - opened),
    dailyLossRoom: Math.round(dailyRoom(rules, s, nowMs) * 100) / 100,
    driver: s.driver ?? "auto",
    positions: s.positions.map((p) => ({ symbol: p.symbol, style: p.style, setup: p.setup, qty: p.qty, entry: p.entry, stop: p.stop, target: p.target, last: p.lastPrice, unrealized: Math.round(((p.lastPrice - p.entry) * p.qty - p.fees) * 100) / 100, openedAt: p.openedAt, by: p.by })),
    paperWorkspace: paperRoot(),
    runSkillsFrom: `cd ${paperRoot()} && python3 …  (never from the repo root: that is the real IBKR portfolio)`,
  };
}

const currentSession = (s: DeskState) => (s.sessions ?? []).find((x) => x.status === "running" && x.model === TEAM);
const TEAM = "Claude Code trade team";

async function main() {
  const nowMs = Date.now();
  const at = new Date(nowMs).toISOString();
  const { date: today } = nyClock(nowMs);
  if (!cmd || cmd === "help") fail("commands: prep, status, book, stop, close, session start|end, log, driver");

  await withDeskLock(async () => {
    const { rules } = await readDeskRules();
    const s = await loadOrCreateDesk(rules);
    let result: Record<string, unknown> = {};

    switch (cmd) {
      case "status":
        result = account(s, rules, nowMs);
        break;

      case "prep": {
        s.driver = "team";
        const report = await runDesk(s, rules, { manageOnly: true, useAgent: false });
        await writePaperWorkspace(s, today);
        result = { ...account(s, rules, nowMs), exitsThisRun: report.exits, notes: report.notes, recentJournal: s.journal.slice(0, 6).map((j) => `${j.at} ${j.kind} ${j.text}`) };
        break;
      }

      case "driver": {
        if (sub !== "team" && sub !== "auto") fail("driver team|auto");
        s.driver = sub as "team" | "auto";
        result = { driver: s.driver };
        break;
      }

      case "book": {
        const style = (flag("style") ?? "day") as Style;
        if (style !== "day" && style !== "swing") fail("--style day|swing");
        const thesis = flag("thesis") ?? "";
        if (thesis.length < 20) fail("--thesis is required: the team's reasons, in a sentence or two");
        const readJson = async (p: string) => JSON.parse(await readFile(p, "utf8").catch(() => "null"));
        const ordersPath = paperFile("orders.json");
        const acc = acceptTeamOrder(await readJson(ordersPath), await readJson(paperFile("state/risk.json")), nowMs);
        if (!acc.ok) fail(`not booked: ${acc.reason}`);
        if (!acc.ok) return;
        const o = acc.order;
        const ms = marketStatus(nowMs);
        const live = await getQuote(o.symbol).then((q) => q.price).catch(() => undefined);
        if (live === undefined) fail(`not booked: no live price for ${o.symbol}`);
        const entry = buyFill(live!);
        const gate = riskGate(rules, s, { symbol: o.symbol, style, entry, stop: o.stop, target: o.target }, nowMs, ms.open);
        if (!gate.ok) fail(`not booked: Dodona's desk rules say ${gate.reason}`);
        const fee = feeCheck(o.qty, entry - o.stop);
        if (fee) fail(`not booked: ${fee}`);
        if (o.qty * entry + 1 > s.cash) fail(`not booked: ${o.qty} × $${entry.toFixed(2)} is more than the paper cash $${s.cash.toFixed(2)}`);
        const drift = (entry - o.entry) / o.entry;
        const pos = openPosition(s, { symbol: o.symbol, style, setup: flag("setup") ?? o.setup ?? "team plan", qty: o.qty, entry, stop: o.stop, target: o.target, openedAt: at, entryDate: today, maxHoldDays: style === "swing" ? 20 : 1, by: "team", thesis }, at);
        log(s, { kind: "buy", symbol: o.symbol, by: "team", text: `Bought ${o.qty} ${o.symbol} at $${entry.toFixed(2)} (${pos.setup}, ${style}). Stop $${o.stop.toFixed(2)}, target $${o.target.toFixed(2)}, max loss $${(o.qty * (entry - o.stop)).toFixed(2)}; trader-risk PASS. ${thesis}` }, at);
        const sess = currentSession(s);
        if (sess) sess.steps.push({ at, kind: "decision", agent: "lead", title: `Booked ${o.qty} ${o.symbol} on paper at $${entry.toFixed(2)}`, detail: thesis });
        await rename(ordersPath, paperFile(`orders-booked-${at.replace(/[:.]/g, "-")}.json`));
        markDay(s, nowMs);
        await writePaperWorkspace(s, today);
        result = { ok: true, booked: { symbol: o.symbol, qty: o.qty, entry, stop: o.stop, target: o.target, style }, slippageVsPlan: Math.round(drift * 10_000) / 100 + "%", account: account(s, rules, nowMs) };
        break;
      }

      case "stop": {
        const sym = (flag("symbol") ?? "").toUpperCase();
        const p = s.positions.find((x) => x.symbol === sym);
        if (!p) fail(`no open paper position in ${sym}`);
        const r = raiseStop(p!, Number(flag("price")));
        if (!r.ok) fail(`stop not changed: ${r.why}`);
        log(s, { kind: "stop-raised", symbol: sym, by: "team", text: `${sym}: ${r.why}. ${flag("why") ?? ""}` }, at);
        await writePaperWorkspace(s, today);
        result = { ok: true, symbol: sym, stop: p!.stop };
        break;
      }

      case "close": {
        const sym = (flag("symbol") ?? "").toUpperCase();
        const p = s.positions.find((x) => x.symbol === sym);
        if (!p) fail(`no open paper position in ${sym}`);
        const px = await getQuote(sym).then((q) => q.price).catch(() => p!.lastPrice);
        const t = closePosition(s, p!.id, px, at, "agent", flag("why") ?? "closed by the trade team");
        if (t) log(s, { kind: "sell", symbol: sym, by: "team", text: `Closed ${t.qty} ${sym} at $${t.exit.toFixed(2)}: ${flag("why") ?? ""} ${t.pnl >= 0 ? "+" : "−"}$${Math.abs(t.pnl).toFixed(2)} (${t.R >= 0 ? "+" : ""}${t.R}R).` }, at);
        markDay(s, nowMs);
        await writePaperWorkspace(s, today);
        result = { ok: true, closed: t };
        break;
      }

      case "session": {
        if (sub === "start") {
          for (const x of s.sessions ?? []) if (x.status === "running" && x.model === TEAM) Object.assign(x, { status: "error", error: "superseded by a new session", endedAt: at });
          const sess: AgentSession = { id: `T-${nowMs.toString(36)}`, startedAt: at, model: TEAM, status: "running", trigger: flag("trigger") ?? "Trade desk cycle", steps: [], toolCalls: 0, rounds: 0, usage: { input: 0, output: 0, cacheRead: 0 }, transcript: flag("transcript") };
          s.sessions = [sess, ...(s.sessions ?? [])].slice(0, SESSIONS_MAX);
          result = { ok: true, session: sess.id };
        } else if (sub === "end") {
          const sess = currentSession(s);
          if (!sess) fail("no running team session");
          sess!.status = flag("status") === "error" ? "error" : "done";
          sess!.summary = flag("summary");
          sess!.endedAt = at;
          if (sess!.summary) s.lastSummary = sess!.summary;
          s.lastAgentAt = at;
          result = { ok: true, session: sess!.id, steps: sess!.steps.length };
        } else fail("session start|end");
        break;
      }

      case "log": {
        const sess = currentSession(s);
        if (!sess) fail("no running team session: npm run desk -- session start first");
        const kind = (flag("kind") ?? "text") as "text" | "decision" | "error";
        sess!.steps.push({ at, kind: ["text", "decision", "error"].includes(kind) ? kind : "text", agent: flag("agent") ?? "lead", title: flag("title") ?? "Note", detail: flag("text") });
        result = { ok: true, steps: sess!.steps.length };
        break;
      }

      default:
        fail(`unknown command ${cmd}`);
    }
    await writeDesk(s);
    out(result);
  });
}

main().catch((e) => {
  out({ ok: false, error: e instanceof Error ? e.message : String(e) });
  process.exit(1);
});
