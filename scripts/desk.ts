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
//   npm run desk -- stage add [--trigger P] | list | drop | done | clear   REAL account: stage the morning batch
//   npm run desk -- candidate --symbol X --trigger P --stop S --target T --verdict take|skip --why "…" [--setup orb --mode live --chart-score 4 --market normal --recheck volume,vwap,market]
//   npm run desk -- review [--date YYYY-MM-DD]     replay the day's candidates on real bars and grade the calls
//   npm run desk -- shortlist build | show | drop --symbol X --why "…"   the pre-market shortlist (trader/shortlist.json) live runs scan
//   npm run desk -- pending [--all] [--only A,B]  formed-not-broken ranges: today's shortlist only, or the whole market with --all; --only re-checks just those stocks
import { appendFile, mkdir, readdir, rename, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { rulesBrief } from "../lib/budget";
import { isRecheck, RECHECKS } from "../lib/board";
import { auditStats, learningStats, replay, ruleAudit, type AuditRow, type Candidate, type Replay } from "../lib/learning";
import { scanPending } from "../lib/data/pending";
import { buildShortlist, dropFromShortlist, readShortlist, todaysShortlist } from "../lib/data/shortlist";
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
import { getIntraday, getQuote } from "../lib/data";
import { loadOrCreateDesk, readDeskRules, withDeskLock, writeDesk } from "../lib/data/desk";
import { runDesk } from "../lib/data/deskRun";
import { acceptTeamOrder, paperFile, paperRoot, writePaperWorkspace } from "../lib/data/paper";
import { PRACTICE_OFF, practiceOn } from "../lib/data/practice";
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
    ledger: "PRACTICE ledger (fake money). This is not the real-money setting: that is \"paper\" in trader/config.json at the repo root.",
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
        // the practice ledger only runs in paper mode; a real-money run has nothing to prep here
        if (!(await practiceOn())) fail(`${PRACTICE_OFF} \`desk prep\` manages the practice ledger, so it doesn't run now. A live run starts with \`stage clear\`.`);
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
        if (!(await practiceOn())) fail(`${PRACTICE_OFF} \`desk book\` books on the practice ledger, so it doesn't run now. Real trades are staged (\`desk stage add\`) and the user approves them in Dodona.`);
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
          // the rules in force right now, read fresh: the team works from these, never from an earlier run
          const cfg = JSON.parse(await readFile(resolve(process.cwd(), "trader", "config.json"), "utf8").catch(() => "{}"));
          result = { ok: true, session: sess.id, rules: rulesBrief(cfg), rulesNote: "Read from trader/config.json just now. Use these numbers for this run. If the user changes them mid-run, the scripts (size.py, check.py, desk stage) read the file again and win." };
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

      case "pending": {
        // Opening ranges formed but NOT broken yet, market-wide: the candidates for buy-stop orders.
        const real = (p: string) => resolve(process.cwd(), "trader", p);
        const pf = JSON.parse(await readFile(real("portfolio.json"), "utf8").catch(() => "null"));
        const held = ((pf?.positions ?? []) as Array<{ ticker?: string }>).map((p) => String(p.ticker ?? "").toUpperCase()).filter(Boolean);
        const maxPrice = Number(flag("max-price")) || Math.min((rules.budget * (1 - rules.cash_buffer_pct / 100)), (rules.budget * rules.max_position_pct) / 100, rules.max_order_usd);
        // today's pre-market shortlist when there is one (trade-screener built it); --all scans the whole market
        const shortlist = argv.includes("--all") ? null : await todaysShortlist();
        // --only KO,F: a run the watch started re-checks just the stocks it was started for, never the
        // ones earlier runs already worked today (the watch logged its own scan of the whole list)
        const only = (flag("only") ?? process.env.DESK_ONLY ?? "").split(",").map((x) => x.trim().toUpperCase()).filter((x) => /^[A-Z][A-Z0-9.\-]{0,9}$/.test(x));
        const listed = only.length ? (shortlist ?? only).filter((x) => only.includes(x.toUpperCase())) : shortlist;
        const scan = await scanPending({ ...(listed ? { symbols: listed } : {}), maxPrice, exclude: [...held, ...rules.blocked], limit: Number(flag("limit")) || 8, confirm: Number(flag("confirm")) || 150, ...(flag("min-range") ? { minRangePct: Number(flag("min-range")) } : {}) });
        // every scan is kept for the Desk's session card: what each run looked at and why nothing was ready
        await mkdir(real("runs"), { recursive: true });
        if (!only.length) await appendFile(real(`runs/scans-${nyClock(nowMs).date}.jsonl`), JSON.stringify({ at: scan.at, source: listed ? "shortlist" : "market", universe: scan.universe, early: scan.early, checked: scan.confirmed, rejected: scan.rejected, ready: scan.pending.map((x) => x.symbol) }) + "\n").catch(() => undefined);
        result = { ...scan, source: only.length ? `only ${listed!.join(", ") || "(none of them is on today's shortlist)"}, the stocks this run was started for` : listed ? `today's shortlist (${listed.length} names)` : "the whole market (no shortlist for today)", maxPrice, excludedHeld: held.length, next: "for the best ones: trade-chartist, then trade-exit with --entry <orHigh> --or-high <orHigh> --or-low <orLow> --setup orb, Time Machine, budget, stage add" };
        break;
      }

      case "shortlist": {
        // Before the open: the day's shortlist from daily closes (uptrend, liquid, moves enough, beats SPY,
        // fits the account), so the live runs only look for ranges in names that pass the basics.
        if (sub === "build") {
          const real = (p: string) => resolve(process.cwd(), "trader", p);
          const pf = JSON.parse(await readFile(real("portfolio.json"), "utf8").catch(() => "null"));
          const held = ((pf?.positions ?? []) as Array<{ ticker?: string }>).map((p) => String(p.ticker ?? "").toUpperCase()).filter(Boolean);
          const maxPrice = Number(flag("max-price")) || Math.min((rules.budget * (1 - rules.cash_buffer_pct / 100)), (rules.budget * rules.max_position_pct) / 100, rules.max_order_usd);
          const doc = await buildShortlist({ maxPrice, exclude: [...held, ...rules.blocked], keep: Number(flag("keep")) || 40 });
          result = { date: doc.date, universe: doc.universe, fetched: doc.fetched, spyReturn20: doc.spyReturn20, maxPrice, kept: doc.kept.length, top: doc.kept.slice(0, Number(flag("show")) || 15), reasons: doc.reasons, file: "trader/shortlist.json", next: "trade-news on the top names (one news.py call), then `shortlist drop --symbol X --why` for every AVOID" };
        } else if (sub === "drop") {
          const sym = flag("symbol");
          const why = flag("why");
          if (!sym || !why) fail("shortlist drop needs --symbol and --why");
          const doc = await dropFromShortlist(sym!, why!, flag("by") ?? "news");
          result = { ok: true, dropped: sym!.toUpperCase(), kept: doc.kept.length };
        } else {
          const doc = await readShortlist();
          result = doc ? { date: doc.date, today: doc.date === nyClock(Date.now()).date, built_at: doc.built_at, kept: doc.kept, dropped: doc.dropped, reasons: doc.reasons } : { today: false, note: "no shortlist yet: `npm run desk -- shortlist build`" };
        }
        break;
      }

      case "candidate": {
        // Every candidate the team looks at, taken or skipped, for the daily review (trader/learning/).
        const n = (k: string) => Number(flag(k));
        const c: Candidate = {
          at,
          date: today,
          mode: flag("mode") === "live" ? "live" : "paper",
          symbol: (flag("symbol") ?? "").toUpperCase(),
          setup: flag("setup") ?? "orb",
          trigger: n("trigger"),
          stop: n("stop"),
          target: n("target"),
          verdict: flag("verdict") === "take" ? "take" : "skip",
          why: flag("why") ?? "",
          ...(flag("chart-score") ? { chartScore: n("chart-score") } : {}),
          ...(flag("market") ? { marketMode: flag("market") } : {}),
          ...(flag("recheck") ? { recheck: flag("recheck")!.split(",").map((x) => x.trim()).filter(Boolean) } : {}),
        };
        const badRecheck = (c.recheck ?? []).filter((x) => !isRecheck(x));
        if (badRecheck.length) fail(`--recheck takes ${Object.keys(RECHECKS).join(", ")} (comma-separated), not ${badRecheck.join(", ")}`);
        if (c.recheck?.length && c.verdict !== "skip") fail("--recheck is only for a skip");
        if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(c.symbol)) fail("--symbol is required");
        if (!(c.trigger > c.stop && c.target > c.trigger)) fail("--trigger, --stop and --target are required (stop < trigger < target)");
        if (!flag("verdict")) fail("--verdict take|skip is required");
        const dir = resolve(process.cwd(), "trader", "learning");
        await mkdir(dir, { recursive: true });
        await appendFile(join(dir, "candidates.jsonl"), JSON.stringify(c) + "\n");
        result = { ok: true, logged: c };
        break;
      }

      case "review": {
        // Replay every candidate of a day on its real 5-minute bars, grade the calls, add up what works.
        const date = flag("date") ?? today;
        const dir = resolve(process.cwd(), "trader", "learning");
        const all = (await readFile(join(dir, "candidates.jsonl"), "utf8").catch(() => ""))
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l) as Candidate);
        const day = all.filter((c) => c.date === date);
        const replays: Replay[] = [];
        for (const c of day) replays.push(replay(c, await getIntraday(c.symbol).catch(() => []), minuteOf(rules.flat_by)));
        // the rule audit: every stock on that day's shortlist, as the 9:46 scan saw it and as if bought anyway
        const archived = JSON.parse(await readFile(join(dir, "shortlists", `${date}.json`), "utf8").catch(() => "null"));
        const current = JSON.parse(await readFile(resolve(process.cwd(), "trader", "shortlist.json"), "utf8").catch(() => "null"));
        const sl = archived ?? (current?.date === date ? current : null);
        const names: string[] = (sl?.kept ?? []).map((k: { symbol: string }) => k.symbol);
        const bars: Record<string, Awaited<ReturnType<typeof getIntraday>>> = {};
        for (const sym of names) bars[sym] = await getIntraday(sym).catch(() => []);
        const audit = ruleAudit(date, bars, minuteOf(rules.flat_by));
        await mkdir(join(dir, "reviews"), { recursive: true });
        // written every day, even with no candidates: the audit is data too, and the file marks the day reviewed
        await writeFile(join(dir, "reviews", `${date}.json`), JSON.stringify({ date, reviewed_at: at, replays, audit }, null, 2) + "\n");
        const history: Replay[] = [];
        const auditHistory: AuditRow[] = [];
        let auditDays = 0;
        for (const f of (await readdir(join(dir, "reviews")).catch(() => [] as string[])).filter((f) => f.endsWith(".json"))) {
          const doc = JSON.parse(await readFile(join(dir, "reviews", f), "utf8"));
          history.push(...(doc.replays ?? []));
          auditHistory.push(...(doc.audit ?? []));
          if (doc.audit?.length) auditDays++;
        }
        result = {
          date,
          candidates: day.length,
          replays: replays.map((r) => ({ symbol: r.symbol, mode: r.mode, verdict: r.verdict, outcome: r.outcome, R: r.R, triggeredAt: r.triggeredAt, exitAt: r.exitAt, rightCall: r.rightCall, chartScore: r.chartScore, why: r.why })),
          today: learningStats(replays),
          allTime: learningStats(history),
          ruleAudit: { shortlisted: names.length, today: auditStats(audit), allTime: auditStats(auditHistory), days: auditDays, note: "each rule: stocks it kept out at 9:46, how many would have triggered, their average R if bought anyway (stop at the range low, target 2R). 'passed the scan' is what the scan let through." },
          playbook: "trader/playbook.md",
        };
        break;
      }

      case "stage": {
        // The real-account morning batch (repo root trader/, NOT the paper workspace): collect each
        // candidate's trader-budget order as a buy-stop at its plan's entry, then hand trader-risk one
        // batch. Nothing here talks to a broker: you approve and place the batch in Dodona's IBKR panel.
        const real = (p: string) => resolve(process.cwd(), "trader", p);
        const readJson = async (p: string) => JSON.parse(await readFile(p, "utf8").catch(() => "null"));
        const staged: Array<Record<string, unknown>> = (await readJson(real("staged.json")))?.orders ?? [];
        const save = (orders: unknown[]) => writeFile(real("staged.json"), JSON.stringify({ orders, updated_at: at }, null, 2) + "\n");
        const brief = (o: Record<string, unknown>) => ({ symbol: o.symbol, qty: o.qty, trigger: o.stop_price, stop: o.stop_loss_stop_price, target: o.take_profit_limit_price, max_loss: (o.plan as Record<string, unknown>)?.max_loss });
        if (sub === "add") {
          const doc = await readJson(real("orders.json"));
          const orders = (doc?.orders ?? []) as Array<Record<string, unknown>>;
          if (orders.length !== 1) fail(`trader/orders.json has ${orders.length} orders; run /trader-budget --write for one candidate first`);
          const o = { ...orders[0] };
          const plan = (o.plan ?? {}) as Record<string, unknown>;
          if (String(o.side).toLowerCase() !== "buy" || o.order_class !== "bracket") fail("only a buy bracket (stop-loss and take-profit) can be staged");
          const trigger = Number(flag("trigger") ?? plan.entry);
          if (!(trigger > Number(o.stop_loss_stop_price) && trigger < Number(o.take_profit_limit_price))) fail("the trigger must sit between the stop and the target");
          const sym = String(o.symbol).toUpperCase();
          if (staged.some((x) => String(x.symbol).toUpperCase() === sym)) fail(`${sym} is already staged`);
          Object.assign(o, { type: "stop", stop_price: trigger.toFixed(2), time_in_force: "day" });
          o.plan = { ...plan, entry: trigger, style: flag("style") ?? plan.style ?? "day", thesis: flag("thesis") ?? plan.thesis };
          staged.push(o);
          await save(staged);
          result = { ok: true, staged: staged.map(brief), next: "stage the next candidate, or `npm run desk -- stage done` and then /trader-risk" };
        } else if (sub === "list") {
          result = { staged: staged.map(brief) };
        } else if (sub === "done") {
          if (!staged.length) fail("nothing staged");
          await writeFile(real("orders.json"), JSON.stringify({ created_by: "dodona stage", created_at: at, status: "proposed", orders: staged }, null, 2) + "\n");
          result = { ok: true, batch: staged.map(brief), next: "run /trader-risk (check.py --json) on trader/orders.json; then the user approves the batch in Dodona's IBKR panel" };
        } else if (sub === "drop") {
          const sym = (flag("symbol") ?? "").toUpperCase();
          const left = staged.filter((x) => String(x.symbol).toUpperCase() !== sym);
          if (left.length === staged.length) fail(`${sym} isn't staged`);
          await save(left);
          result = { ok: true, staged: left.map(brief), next: "`npm run desk -- stage done` again, then /trader-risk again" };
        } else if (sub === "clear") {
          await save([]);
          result = { ok: true, staged: [] };
        } else fail("stage add|list|drop|done|clear");
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
