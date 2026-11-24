// Server only. Starts the trade team as a background Claude Code session from the Desk's "Run desk
// now" button (when the team drives the desk), and reports how it's going: `/trade-desk live` (the
// LIVE MORNING batch for IBKR, when real orders are on) or `/trade-desk` (one paper cycle). After the
// close it also starts `/trade-desk review` by itself (the coach updates the playbook): see
// ensureReviewScheduler.
//
// A live run only PREPARES: it scans, plans, sizes, stages the day's buy-stop brackets and gets
// trader-risk's verdict. It can't place, change or cancel an order: it's allowed npm's desk and
// gateway-status commands, the skill scripts and reading files, and nothing else (no editing, no web,
// no curl). The batch then waits in the IBKR orders panel for the user's typed confirmation and click.
// One run at a time; the Claude Code session uses the user's own plan.
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { dueSlot, openNote, parseAutoTimes, runNote, watchSlot } from "../autoBatch";
import { buildBoard, dueForTeam, latestDecisions, type Board } from "../board";
import { rulesBrief } from "../budget";
import { normalizeDeskRules } from "../desk";
import { marketStatus, tradingDay } from "../clock";
import { gatewayStatus, syncFromGateway } from "./ibkr";
import { nyClock } from "../setups";
import { getIntraday } from "./index";
import { scanPending } from "./pending";
import { todaysShortlist } from "./shortlist";
import { PRACTICE_OFF, practiceOn } from "./practice";

const dir = () => resolve(process.cwd(), "trader", "runs");
const STATE = () => join(dir(), "live-run.json");

interface RunState {
  pid: number;
  startedAt: string;
  log: string;
  mode?: RunMode;
}

export type RunMode = "live" | "paper" | "review" | "screen" | "research";

export interface LiveRun {
  mode?: RunMode;
  running: boolean;
  startedAt?: string;
  endedAt?: string;
  lines: string[]; // the lead's latest messages and steps, newest last
  result?: string; // the run's final answer
  costUsd?: number;
  error?: string;
}

// Exactly what the run may do. Skill scripts run from the repo root (the real portfolio and rules).
const ALLOWED = [
  "Bash(npm run desk:*)",
  "Bash(npm run -s desk:*)",
  "Bash(npm run -s ibkr -- status)",
  "Bash(npm run ibkr -- status)",
  "Bash(python3 .claude/skills/*)",
  "Bash(cd *)",
  "Bash(cd:*)",
  "Bash(python3 ../../.claude/skills/*)",
  "Bash(npm run -s chart:*)",
  "Bash(npm run chart:*)",
  "Read",
  "Glob",
  "Grep",
  "Agent",
  "Task",
  "Skill",
];
// the coach may edit the playbook, and nothing else
const REVIEW_ALLOWED = ["Edit(trader/playbook.md)", "Write(trader/playbook.md)", "Edit(./trader/playbook.md)", "Write(./trader/playbook.md)"];
// the strategist runs the backtest and writes its report, and nothing else
const RESEARCH_ALLOWED = ["Bash(npm run -s research:*)", "Bash(npm run research:*)", "Write(trader/research/report.md)", "Write(./trader/research/report.md)", "Edit(trader/research/report.md)", "Edit(./trader/research/report.md)"];
const BLOCKED_ALWAYS = ["NotebookEdit", "WebFetch", "WebSearch", "Bash(curl:*)", "Bash(wget:*)", "Bash(rm:*)", "Bash(git:*)"];
const BLOCKED = ["Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch", "Bash(curl:*)", "Bash(wget:*)", "Bash(rm:*)", "Bash(git:*)"];
const NOTE =
  "You were started by Dodona (its Run button, its watch or its timer), with no one watching the chat. In LIVE MORNING mode your working directory is the repo root: run skill scripts as `python3 .claude/skills/<skill>/<script>.py …` (no cd), and tell every subagent the same, plus LIVE MORNING. In a paper cycle, skills run in trader/paper as usual (`cd trader/paper && python3 ../../.claude/skills/<skill>/<script>.py …`). Never put `$(...)` or backticks in a command (they can't be approved here), and tell every subagent the same. Dodona's own scripts (`npm run -s chart`, `npm run -s desk`) run from the repo root. Only stage, book on paper and check: never place, change or cancel an order (the user does that in Dodona). If a step needs the user (the gateway isn't logged in, it's outside the window), log it with `npm run desk -- log`, end the session, and stop. Real money or practice is decided by one setting only: \"paper\" in trader/config.json at the repo root. In LIVE MORNING mode never run `desk prep` or `desk book` (they're the practice ledger) and never read anything under trader/paper/ (the practice copy always says paper: true and is not the user's setting).";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function state(): Promise<RunState | null> {
  return JSON.parse(await readFile(STATE(), "utf8").catch(() => "null"));
}

export async function startLiveRun(mode: RunMode = "live", arg?: string, context?: string): Promise<{ ok: boolean; error?: string; run?: LiveRun }> {
  const st = await state();
  if (st && alive(st.pid)) return { ok: false, error: "A run is already going." };
  // a paper cycle is practice: none while paper mode is off (it would spend tokens on fake trades)
  if (mode === "paper" && !(await practiceOn())) return { ok: false, error: PRACTICE_OFF };
  await mkdir(dir(), { recursive: true });
  // the team sizes from, and leaves out, the real portfolio: refresh it from IBKR first (read-only)
  if (mode === "live") await syncFromGateway().catch(() => undefined);
  // the rules in force as this run starts, read fresh (the user may have changed the money on the Desk)
  const cfg = ((await readJsonFile(resolve(process.cwd(), "trader", "config.json"))) ?? {}) as Record<string, unknown>;
  const at = new Date();
  const log = join(dir(), `live-${at.toISOString().replace(/[:.]/g, "-")}.jsonl`);
  const fd = openSync(log, "a");
  // a run the watch started for some stocks sees only those: `desk pending` reads DESK_ONLY even when the
  // lead forgets --only, so stocks earlier runs already worked today never go through the team again
  const only = mode === "live" && arg && /^[A-Z][A-Z0-9.]{0,9}(,[A-Z][A-Z0-9.]{0,9})*$/.test(arg) ? arg : undefined;
  const child = spawn(
    process.env.CLAUDE_BIN || "claude",
    [
      "-p",
      // the argument is checked to be plain dates or tickers: it lands in the run's prompt
      mode === "live" ? `/trade-desk live${arg && /^[A-Z][A-Z0-9.]{0,9}(,[A-Z][A-Z0-9.]{0,9})*$/.test(arg) ? ` ${arg}` : ""}` : mode === "review" ? `/trade-desk review${arg && /^\d{4}-\d{2}-\d{2}$/.test(arg) ? ` ${arg}` : ""}` : mode === "screen" ? "/trade-desk screen" : mode === "research" ? "/trade-desk research" : "/trade-desk",
      "--output-format",
      "stream-json",
      "--verbose",
      "--allowedTools",
      ...ALLOWED,
      ...(mode === "review" ? REVIEW_ALLOWED : mode === "research" ? RESEARCH_ALLOWED : []),
      "--disallowedTools",
      ...(mode === "review" || mode === "research" ? BLOCKED_ALWAYS : BLOCKED),
      // a live run can't see the practice workspace at all: its copy of the rules says paper: true
      ...(mode === "live" ? ["Read(./trader/paper/**)", "Glob(./trader/paper/**)", "Grep(./trader/paper/**)", "Bash(cd trader/paper:*)"] : []),
      "--append-system-prompt",
      `${NOTE} The user's rules right now (trader/config.json, read when this run started): ${rulesBrief(cfg)}. Use these, never numbers from an earlier run or from the skill's examples, and tell every subagent the ones it needs.${only ? ` This run is for ${only} only: \`npm run -s desk -- pending --only ${only}\`, and work no other stock.` : ""}${context ? ` ${context}` : ""}`,
    ],
    { cwd: process.cwd(), detached: true, stdio: ["ignore", fd, fd], env: only ? { ...process.env, DESK_ONLY: only } : process.env },
  );
  closeSync(fd);
  if (!child.pid) return { ok: false, error: "Couldn't start Claude Code (is the `claude` command installed? Set CLAUDE_BIN in .env.local)." };
  child.unref();
  await writeFile(STATE(), JSON.stringify({ pid: child.pid, startedAt: at.toISOString(), log, mode } satisfies RunState, null, 2));
  return { ok: true, run: await liveRun() };
}

export async function stopLiveRun(): Promise<boolean> {
  const st = await state();
  if (!st || !alive(st.pid)) return false;
  try {
    process.kill(-st.pid, "SIGTERM"); // the whole group: the lead and its subagents
  } catch {
    process.kill(st.pid, "SIGTERM");
  }
  return true;
}

/** Read the run's stream-json log into a few readable lines. */
export function summarize(text: string): Omit<LiveRun, "running" | "startedAt"> {
  const lines: string[] = [];
  let result: string | undefined, costUsd: number | undefined, error: string | undefined, endedAt: string | undefined;
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(raw);
    } catch {
      if (raw.trim()) lines.push(raw.trim().slice(0, 200));
      continue;
    }
    if (m.type === "assistant" && !m.parent_tool_use_id) {
      for (const b of ((m.message as { content?: Array<Record<string, unknown>> })?.content ?? [])) {
        if (b.type === "text" && String(b.text ?? "").trim()) lines.push(String(b.text).trim().split("\n")[0].slice(0, 200));
        else if (b.type === "tool_use") {
          const inp = (b.input ?? {}) as Record<string, unknown>;
          if (b.name === "Agent" || b.name === "Task") lines.push(`→ ${inp.subagent_type ?? "subagent"}: ${inp.description ?? ""}`);
          else if (b.name === "Bash") lines.push(`$ ${String(inp.command ?? "").split("\n")[0].slice(0, 160)}`);
        }
      }
    } else if (m.type === "result") {
      result = String(m.result ?? "");
      costUsd = typeof m.total_cost_usd === "number" ? m.total_cost_usd : undefined;
      if (m.is_error) error = String(m.result ?? m.subtype ?? "error");
      endedAt = new Date().toISOString();
    }
  }
  return { lines: lines.slice(-12), result, costUsd, error, endedAt };
}

export async function liveRun(): Promise<LiveRun> {
  const st = await state();
  if (!st) return { running: false, lines: [] };
  const text = await readFile(st.log, "utf8").catch(() => "");
  return { running: alive(st.pid), mode: st.mode ?? "live", startedAt: st.startedAt, ...summarize(text) };
}

// ---------------------------------------------------------------- the daily review, on its own

const g = globalThis as unknown as { __dodonaReviewTimer?: ReturnType<typeof setInterval>; __dodonaTimerVersion?: number };

function nyNow(now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minute: Number(p.hour) * 60 + Number(p.minute), weekend: p.weekday === "Sat" || p.weekday === "Sun" };
}

/**
 * The day the coach should review now, or undefined: the latest trading day whose close has passed
 * (today after 4:10 PM New York, else the trading day before). Never during 9:10 AM-4:10 PM on a
 * trading day: the screen and the watch need the one run slot then.
 */
export function reviewDay(now = new Date()): string | undefined {
  const ny = nyNow(now);
  const todayTrades = !ny.weekend && tradingDay(ny.date).ok;
  if (todayTrades && ny.minute >= 9 * 60 + 10 && ny.minute < 16 * 60 + 10) return undefined;
  if (todayTrades && ny.minute >= 16 * 60 + 10) return ny.date;
  for (let d = 1; d < 10; d++) {
    const day = new Date(Date.parse(`${ny.date}T12:00:00Z`) - d * 86_400_000).toISOString().slice(0, 10);
    if (tradingDay(day).ok) return day;
  }
  return undefined;
}

const REVIEW_TRIES = () => join(dir(), "review-tries.json");

/**
 * The coach reviews every trading day, candidates or not (the rule audit is data even on a quiet day),
 * and catches up when Dodona was off after the close: a day counts as reviewed once its
 * trader/learning/reviews/<day>.json exists. Two tries a day at most.
 */
export async function maybeStartReview(now = new Date()): Promise<"started" | "not-yet" | "done" | "gave-up" | "busy"> {
  const day = reviewDay(now);
  if (!day) return "not-yet";
  const file = resolve(process.cwd(), "trader", "learning", "reviews", `${day}.json`);
  if ((await readFile(file, "utf8").catch(() => "")).includes('"reviewed_at"')) return "done";
  const st = await state();
  if (st && alive(st.pid)) return "busy";
  const tries = ((await readJsonFile(REVIEW_TRIES())) ?? {}) as { day?: string; n?: number; at?: number };
  const n = tries.day === day ? (tries.n ?? 0) : 0;
  if (n >= 2) return "gave-up";
  if (tries.day === day && tries.at && now.getTime() - tries.at < 30 * 60_000) return "busy"; // give a run half an hour
  await mkdir(dir(), { recursive: true });
  await writeFile(REVIEW_TRIES(), JSON.stringify({ day, n: n + 1, at: now.getTime() }));
  return (await startLiveRun("review", day)).ok ? "started" : "busy";
}

const RESEARCH_TRIES = () => join(dir(), "research-tries.json");

/** Saturday from 10 AM New York, or Sunday if Dodona was off: the strategist's weekly research run. */
export function researchDue(now: Date, lastRanAt?: string): boolean {
  const ny = nyNow(now);
  const dow = new Date(`${ny.date}T12:00:00Z`).getUTCDay(); // 6 Saturday, 0 Sunday
  if (!(dow === 6 || dow === 0) || ny.minute < 10 * 60) return false;
  return !lastRanAt || now.getTime() - Date.parse(lastRanAt) > 4 * 86_400_000;
}

/** The weekly research run, while Dodona is running and real orders are on. One try a day. */
export async function maybeStartResearch(now = new Date()): Promise<string> {
  const cfg = ((await readJsonFile(resolve(process.cwd(), "trader", "config.json"))) ?? {}) as Record<string, unknown>;
  if (cfg.auto_batch !== true || cfg.ibkr_orders !== true) return "off";
  const latest = await readJsonFile(resolve(process.cwd(), "trader", "research", "latest.json"));
  const report = await readFile(resolve(process.cwd(), "trader", "research", "report.md"), "utf8").catch(() => "");
  if (!researchDue(now, report && latest?.ranAt ? latest.ranAt : undefined)) return "not due";
  const day = nyNow(now).date;
  if ((await readJsonFile(RESEARCH_TRIES()))?.day === day) return "tried today";
  const st = await state();
  if (st && alive(st.pid)) return "busy";
  await mkdir(dir(), { recursive: true });
  await writeFile(RESEARCH_TRIES(), JSON.stringify({ day, at: now.getTime() }));
  return (await startLiveRun("research")).ok ? "started" : "busy";
}

// ---------------------------------------------------------------- the batch, by itself

/** A notification on this Mac (macOS only; quietly nothing elsewhere). */
export function notifyMac(title: string, text: string) {
  if (process.platform !== "darwin") return;
  const q = (x: string) => JSON.stringify(x.replace(/"/g, "'"));
  try {
    spawn("osascript", ["-e", `display notification ${q(text)} with title ${q(title)} sound name "Glass"`], { stdio: "ignore", detached: true }).unref();
  } catch {
    /* no notifications: the Desk still shows it */
  }
}

/** DODONA_IMESSAGE_TO: the user's own phone number (+15551234567) or Apple ID email; anything else is ignored. */
export function imessageTo(v = process.env.DODONA_IMESSAGE_TO): string | undefined {
  const s = v?.trim().replace(/[\s().-]/g, "");
  if (!s) return undefined;
  if (/^\+?\d{8,15}$/.test(s)) return s;
  if (/^[^@\s"\\]+@[^@\s"\\]+\.[A-Za-z]{2,}$/.test(v!.trim())) return v!.trim();
  return undefined;
}

/**
 * The same alert as an iMessage from this Mac's Messages app to the user's own number or Apple ID
 * (DODONA_IMESSAGE_TO in .env.local), so it reaches their phone when they're away. Only Apple's
 * iMessage carries it, nothing else. The handle and text go to AppleScript as arguments, never pasted
 * into the script. Resolves to an error message, or undefined when sent.
 */
export function notifyIMessage(text: string): Promise<string | undefined> {
  const to = imessageTo();
  if (process.platform !== "darwin") return Promise.resolve("iMessage alerts need macOS");
  if (!to) return Promise.resolve("set DODONA_IMESSAGE_TO in .env.local to your phone number or Apple ID");
  const script = [
    "on run argv",
    'tell application "Messages"',
    "set svc to 1st account whose service type = iMessage",
    "send (item 2 of argv) to participant (item 1 of argv) of svc",
    "end tell",
    "end run",
  ].join("\n");
  return new Promise((done) => {
    try {
      const p = spawn("osascript", ["-e", script, to, text], { stdio: ["ignore", "ignore", "pipe"] });
      let err = "";
      p.stderr.on("data", (d) => (err += d));
      const t = setTimeout(() => p.kill(), 20_000);
      p.on("close", (code) => {
        clearTimeout(t);
        done(code === 0 ? undefined : err.trim() || `osascript exited ${code}`);
      });
      p.on("error", (e) => done(e.message));
    } catch (e) {
      done(e instanceof Error ? e.message : String(e));
    }
  });
}

/** Tell the user: a banner on this Mac and, when DODONA_IMESSAGE_TO is set, an iMessage to their phone. */
export function notifyUser(title: string, text: string) {
  notifyMac(title, text);
  if (imessageTo()) void notifyIMessage(`${title}: ${text}`);
}

const SCREEN_AT = 9 * 60 + 15; // the pre-market shortlist run, New York
const OPEN_NOTE_AT = 9 * 60 + 35; // the "market is open" text, 5 minutes into the session
const AUTO_DONE = (date: string) => join(dir(), `auto-${date}.json`);
const readJsonFile = async (p: string) => JSON.parse(await readFile(p, "utf8").catch(() => "null"));

/** Start the live batch run at the user's times, when it's safe; tell the user when a batch is ready. */
export async function autoBatchTick(now = new Date()): Promise<string> {
  const cfg = ((await readJsonFile(resolve(process.cwd(), "trader", "config.json"))) ?? {}) as Record<string, unknown>;
  const ny = nyNow(now);
  await notifyWhenReady(now);
  await notifyRunDone(now);
  if (cfg.auto_batch !== true || cfg.ibkr_orders !== true || String(cfg.broker ?? "").toLowerCase() !== "ibkr") return "off";
  await mkdir(dir(), { recursive: true });
  const doneDoc = ((await readJsonFile(AUTO_DONE(ny.date))) ?? { slots: [] }) as { slots: string[] };
  // 5 minutes into the session (9:35-9:59 New York): one text on where the day stands.
  if (!ny.weekend && tradingDay(ny.date).ok && ny.minute >= OPEN_NOTE_AT && ny.minute < 10 * 60 && !doneDoc.slots.includes("open-note")) {
    doneDoc.slots.push("open-note");
    await writeFile(AUTO_DONE(ny.date), JSON.stringify(doneDoc));
    const gw = await gatewayStatus().catch(() => ({ state: "down" as const }));
    const shortlist = await readJsonFile(resolve(process.cwd(), "trader", "shortlist.json"));
    const text = openNote({ date: ny.date, gateway: gw.state, shortlist, times: parseAutoTimes(String(cfg.auto_batch_times ?? "")), nowMinute: ny.minute });
    notifyUser("Dodona: market open", text);
  }
  // Before the open (9:15-9:40 New York): the day's shortlist, once (trade-screener; stages nothing).
  if (!ny.weekend && tradingDay(ny.date).ok && ny.minute >= SCREEN_AT && ny.minute < 9 * 60 + 40 && !doneDoc.slots.includes("screen")) {
    const st = await state();
    if (st && alive(st.pid)) return "a run is going";
    doneDoc.slots.push("screen");
    await writeFile(AUTO_DONE(ny.date), JSON.stringify(doneDoc));
    const r = await startLiveRun("screen");
    return r.ok ? "started screen" : `not started: ${r.error}`;
  }
  if (ny.weekend || !marketStatus(now.getTime()).open) return "market closed";
  const every = Number(cfg.watch_every_min) || 0;
  if (every > 0) return watchTick(cfg, ny, now, every, doneDoc as WatchDoc);
  const slot = dueSlot(parseAutoTimes(String(cfg.auto_batch_times ?? "")), ny.minute, doneDoc.slots);
  if (!slot) return "no slot due";
  const st = await state();
  if (st && alive(st.pid)) return "a run is going";
  // a batch is already waiting for the user (risk-checked within 15 minutes): don't replace it
  const risk = await readJsonFile(resolve(process.cwd(), "trader", "state", "risk.json"));
  const orders = await readJsonFile(resolve(process.cwd(), "trader", "orders.json"));
  if (orders?.orders?.length && risk?.checked_at && now.getTime() - Date.parse(risk.checked_at) < 15 * 60_000) return "a batch is waiting";
  doneDoc.slots.push(slot);
  await writeFile(AUTO_DONE(ny.date), JSON.stringify(doneDoc));
  const gw = await gatewayStatus().catch(() => ({ state: "down" as const }));
  if (gw.state !== "ready") {
    notifyUser("Dodona: IBKR gateway logged out", `The ${slot} batch didn't run. Log in at https://localhost:5001 (or say "refresh IBKR").`);
    return "gateway not ready";
  }
  const r = await startLiveRun("live");
  return r.ok ? `started ${slot}` : `not started: ${r.error}`;
}

type WatchDoc = { slots: string[]; worked?: string[]; workedAt?: Record<string, { at: string; rechecks: number }> };

/** The board the scout writes on each look (trader/runs/board-{date}.json): the Desk reads it. */
export const BOARD = (date: string) => join(dir(), `board-${date}.json`);

/** SPY right now vs its VWAP today, for the "market" re-check. */
async function spyNow(nowMs: number, date: string): Promise<Board["market"] | undefined> {
  const bars = (await getIntraday("SPY").catch(() => [])).filter((b) => { const c = nyClock(b.t); return c.date === date && c.minute >= 570 && b.t + 5 * 60_000 <= nowMs; });
  if (!bars.length) return undefined;
  let pv = 0, v = 0;
  for (const b of bars) { pv += ((b.high + b.low + b.close) / 3) * b.volume; v += b.volume; }
  const spy = bars[bars.length - 1].close, vwap = v ? pv / v : spy;
  return { spy: Math.round(spy * 100) / 100, vwap: Math.round(vwap * 100) / 100, aboveVwap: spy > vwap };
}

/**
 * The scout: one look at the shortlist, every `every` minutes from 9:46 to 3:00 New York. Dodona's own
 * scan (code, no Claude, no tokens) writes the board every time, even while the team is busy. The team
 * (`/trade-desk live`) is woken only for a stock that's ready and new today, or for a skip whose
 * re-check reasons have all cleared (lib/board.ts). Like the batch times, it only prepares: the user
 * approves on the Desk.
 */
async function watchTick(cfg: Record<string, unknown>, ny: { date: string; minute: number }, now: Date, every: number, doneDoc: WatchDoc): Promise<string> {
  const slot = watchSlot(ny.minute, every);
  if (!slot) return "outside the watch window";
  if (doneDoc.slots.includes(slot)) return "watching";
  doneDoc.slots.push(slot);
  // older files kept a plain list: those stocks were worked earlier today
  doneDoc.workedAt ??= Object.fromEntries((doneDoc.worked ?? []).map((s) => [s, { at: `${ny.date}T00:00:00Z`, rechecks: 0 }]));
  await writeFile(AUTO_DONE(ny.date), JSON.stringify(doneDoc));
  const listed = await todaysShortlist(now.getTime());
  if (!listed?.length) return "no shortlist for today";
  const rules = normalizeDeskRules(cfg);
  const pf = await readJsonFile(resolve(process.cwd(), "trader", "portfolio.json"));
  const held = ((pf?.positions ?? []) as Array<{ ticker?: string }>).map((p) => String(p.ticker ?? "").toUpperCase()).filter(Boolean);
  const maxPrice = Math.min(rules.budget * (1 - rules.cash_buffer_pct / 100), (rules.budget * rules.max_position_pct) / 100, rules.max_order_usd);
  const scan = await scanPending({ symbols: listed, maxPrice, exclude: [...held, ...rules.blocked], limit: 40, confirm: 150, nowMs: now.getTime() });
  const ready = scan.pending.map((x) => x.symbol);
  await appendFile(join(dir(), `scans-${ny.date}.jsonl`), JSON.stringify({ at: scan.at, source: "shortlist", by: "watch", universe: scan.universe, early: scan.early, checked: scan.confirmed, rejected: scan.rejected, ready }) + "\n").catch(() => undefined);
  // the board: every stock's state, the team's latest call on it, what the scout waits for
  const cands = (await readFile(resolve(process.cwd(), "trader", "learning", "candidates.jsonl"), "utf8").catch(() => ""))
    .split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const board = buildBoard({ date: ny.date, at: scan.at, status: scan.status ?? {}, decisions: latestDecisions(cands, ny.date), worked: doneDoc.workedAt, market: await spyNow(now.getTime(), ny.date) });
  await writeFile(BOARD(ny.date), JSON.stringify(board));
  const due = dueForTeam(board, now.getTime());
  if (!due.fresh.length && !due.recheck.length) return ready.length ? `watch: ${ready.join(", ")} already worked today` : "watch: nothing ready";
  // waking the team: only one run at a time, never over a batch waiting for the user, never without IBKR
  const st = await state();
  if (st && alive(st.pid)) return "a run is going (the board is up to date)";
  const risk = await readJsonFile(resolve(process.cwd(), "trader", "state", "risk.json"));
  const orders = await readJsonFile(resolve(process.cwd(), "trader", "orders.json"));
  if (orders?.orders?.length && risk?.checked_at && now.getTime() - Date.parse(risk.checked_at) < 15 * 60_000) return "a batch is waiting";
  const gw = await gatewayStatus().catch(() => ({ state: "down" as const }));
  if (gw.state !== "ready") {
    if (!doneDoc.slots.includes("watch-gateway-note")) {
      doneDoc.slots.push("watch-gateway-note");
      await writeFile(AUTO_DONE(ny.date), JSON.stringify(doneDoc));
      notifyUser("Dodona: IBKR gateway logged out", "The team can't look for trades until you log in at https://localhost:5001 (or say \"refresh IBKR\").");
    }
    return "gateway not ready";
  }
  const at = now.toISOString();
  if (due.fresh.length) {
    for (const s of due.fresh) doneDoc.workedAt[s] = { at, rechecks: 0 };
    doneDoc.worked = Object.keys(doneDoc.workedAt);
    await writeFile(AUTO_DONE(ny.date), JSON.stringify(doneDoc));
    const r = await startLiveRun("live", due.fresh.join(","));
    return r.ok ? `watch ${slot}: team started for ${due.fresh.join(", ")}` : `not started: ${r.error}`;
  }
  // re-checks: the stocks whose skip reasons all cleared, with what changed, so the run decides again fast
  for (const x of due.recheck) doneDoc.workedAt[x.symbol] = { at, rechecks: (doneDoc.workedAt[x.symbol]?.rechecks ?? 0) + 1 };
  await writeFile(AUTO_DONE(ny.date), JSON.stringify(doneDoc));
  const what = due.recheck.map((x) => { const row = board.rows.find((r) => r.symbol === x.symbol); return `${x.symbol} (skipped at ${row?.decision?.at ?? "?"} for ${x.reasons.join(", ")}; now relative volume ${row?.relVolume ?? "?"}, price ${row?.price ?? "?"} vs VWAP ${row?.vwap ?? "?"}, SPY ${board.market?.aboveVwap ? "above" : "below"} its VWAP)`; }).join("; ");
  const r = await startLiveRun("live", due.recheck.map((x) => x.symbol).join(","), `RE-CHECK: ${what}. Those reasons have cleared. Reuse the plan and chart score logged for it today unless the range changed; re-run only what the change touches (the Time Machine from now), then decide again and log the candidate again.`);
  return r.ok ? `watch ${slot}: re-check started for ${due.recheck.map((x) => x.symbol).join(", ")}` : `not started: ${r.error}`;
}

const NOTIFIED = () => join(dir(), "notified.json");
const RUN_NOTIFIED = () => join(dir(), "run-notified.json");

/** Once per batch check or screen run: when it finishes, text the user what it found (staged or not, and why). */
async function notifyRunDone(now: Date) {
  const st = await state();
  if (!st || (st.mode !== "live" && st.mode !== "screen") || alive(st.pid)) return;
  if (now.getTime() - Date.parse(st.startedAt) > 2 * 3600_000) return; // only fresh runs
  if ((await readJsonFile(RUN_NOTIFIED()))?.startedAt === st.startedAt) return;
  const run = summarize(await readFile(st.log, "utf8").catch(() => ""));
  await writeFile(RUN_NOTIFIED(), JSON.stringify({ startedAt: st.startedAt }));
  notifyUser(st.mode === "screen" ? "Dodona: shortlist ready" : "Dodona: batch check done", runNote(run.result, run.error));
}


/** Once per risk check: if a batch is ready for the user, say so on this Mac. */
async function notifyWhenReady(now: Date) {
  const risk = await readJsonFile(resolve(process.cwd(), "trader", "state", "risk.json"));
  const orders = await readJsonFile(resolve(process.cwd(), "trader", "orders.json"));
  if (!risk?.checked_at || !orders?.orders?.length) return;
  if (now.getTime() - Date.parse(risk.checked_at) > 15 * 60_000) return;
  const seen = (await readJsonFile(NOTIFIED()))?.checked_at;
  if (seen === risk.checked_at) return;
  const passed = (risk.results ?? []).filter((r: { verdict?: string }) => r.verdict === "PASS").length;
  if (!passed || passed !== orders.orders.length) return;
  await mkdir(dir(), { recursive: true });
  await writeFile(NOTIFIED(), JSON.stringify({ checked_at: risk.checked_at }));
  const syms = orders.orders.map((o: { qty?: string; symbol?: string }) => `${o.qty} ${o.symbol}`).join(", ");
  notifyUser("Dodona: IBKR batch ready", `${syms}. Approve at the top of the Desk (http://localhost:3000/desk) within 15 minutes, or it expires.`);
}

/** While Dodona runs, check every minute: the batch times, a batch to announce, the daily review. Safe to call often. */
const TIMER_VERSION = 10; // bump when the tick changes, so a running Dodona swaps in the new one
export function ensureReviewScheduler() {
  if (g.__dodonaReviewTimer && g.__dodonaTimerVersion === TIMER_VERSION) return;
  if (g.__dodonaReviewTimer) clearInterval(g.__dodonaReviewTimer);
  g.__dodonaTimerVersion = TIMER_VERSION;
  g.__dodonaReviewTimer = setInterval(() => {
    void autoBatchTick().catch(() => undefined);
    void maybeStartReview().catch(() => undefined);
    void maybeStartResearch().catch(() => undefined);
  }, 60_000);
  g.__dodonaReviewTimer.unref?.();
}
