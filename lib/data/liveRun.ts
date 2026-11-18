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
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { dueSlot, parseAutoTimes } from "../autoBatch";
import { marketStatus } from "../clock";
import { gatewayStatus } from "./ibkr";

const dir = () => resolve(process.cwd(), "trader", "runs");
const STATE = () => join(dir(), "live-run.json");

interface RunState {
  pid: number;
  startedAt: string;
  log: string;
  mode?: RunMode;
}

export type RunMode = "live" | "paper" | "review";

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
const BLOCKED_ALWAYS = ["NotebookEdit", "WebFetch", "WebSearch", "Bash(curl:*)", "Bash(wget:*)", "Bash(rm:*)", "Bash(git:*)"];
const BLOCKED = ["Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch", "Bash(curl:*)", "Bash(wget:*)", "Bash(rm:*)", "Bash(git:*)"];
const NOTE =
  "You were started from Dodona's \"Run desk now\" button, with no one watching the chat. In LIVE MORNING mode your working directory is the repo root: run skill scripts as `python3 .claude/skills/<skill>/<script>.py …` (no cd), and tell every subagent the same, plus LIVE MORNING. In a paper cycle, skills run in trader/paper as usual (`cd trader/paper && python3 ../../.claude/skills/<skill>/<script>.py …`). Never put `$(...)` or backticks in a command (they can't be approved here), and tell every subagent the same. Dodona's own scripts (`npm run -s chart`, `npm run -s desk`) run from the repo root. Only stage, book on paper and check: never place, change or cancel an order (the user does that in Dodona). If a step needs the user (the gateway isn't logged in, it's outside the window), log it with `npm run desk -- log`, end the session, and stop.";

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

export async function startLiveRun(mode: RunMode = "live"): Promise<{ ok: boolean; error?: string; run?: LiveRun }> {
  const st = await state();
  if (st && alive(st.pid)) return { ok: false, error: "A run is already going." };
  await mkdir(dir(), { recursive: true });
  const at = new Date();
  const log = join(dir(), `live-${at.toISOString().replace(/[:.]/g, "-")}.jsonl`);
  const fd = openSync(log, "a");
  const child = spawn(
    process.env.CLAUDE_BIN || "claude",
    [
      "-p",
      mode === "live" ? "/trade-desk live" : mode === "review" ? "/trade-desk review" : "/trade-desk",
      "--output-format",
      "stream-json",
      "--verbose",
      "--allowedTools",
      ...ALLOWED,
      ...(mode === "review" ? REVIEW_ALLOWED : []),
      "--disallowedTools",
      ...(mode === "review" ? BLOCKED_ALWAYS : BLOCKED),
      "--append-system-prompt",
      NOTE,
    ],
    { cwd: process.cwd(), detached: true, stdio: ["ignore", fd, fd], env: process.env },
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

const REVIEW_DONE = () => join(dir(), "last-review.txt");
const g = globalThis as unknown as { __dodonaReviewTimer?: ReturnType<typeof setInterval>; __dodonaTimerVersion?: number };

function nyNow(now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minute: Number(p.hour) * 60 + Number(p.minute), weekend: p.weekday === "Sat" || p.weekday === "Sun" };
}

/** Start today's review once, between 4:10 and 6 PM New York, if the team logged candidates today. */
export async function maybeStartReview(now = new Date()): Promise<"started" | "not-yet" | "done" | "nothing" | "busy"> {
  const ny = nyNow(now);
  if (ny.weekend || ny.minute < 16 * 60 + 10 || ny.minute > 18 * 60) return "not-yet";
  if ((await readFile(REVIEW_DONE(), "utf8").catch(() => "")).trim() === ny.date) return "done";
  const st = await state();
  if (st && alive(st.pid)) return "busy";
  await mkdir(dir(), { recursive: true });
  const logged = (await readFile(resolve(process.cwd(), "trader", "learning", "candidates.jsonl"), "utf8").catch(() => "")).includes(`"date":"${ny.date}"`);
  await writeFile(REVIEW_DONE(), ny.date + "\n");
  if (!logged) return "nothing";
  return (await startLiveRun("review")).ok ? "started" : "busy";
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

const AUTO_DONE = (date: string) => join(dir(), `auto-${date}.json`);
const readJsonFile = async (p: string) => JSON.parse(await readFile(p, "utf8").catch(() => "null"));

/** Start the live batch run at the user's times, when it's safe; tell the user when a batch is ready. */
export async function autoBatchTick(now = new Date()): Promise<string> {
  const cfg = ((await readJsonFile(resolve(process.cwd(), "trader", "config.json"))) ?? {}) as Record<string, unknown>;
  const ny = nyNow(now);
  await notifyWhenReady(now);
  if (cfg.auto_batch !== true || cfg.ibkr_orders !== true || String(cfg.broker ?? "").toLowerCase() !== "ibkr") return "off";
  if (ny.weekend || !marketStatus(now.getTime()).open) return "market closed";
  await mkdir(dir(), { recursive: true });
  const doneDoc = ((await readJsonFile(AUTO_DONE(ny.date))) ?? { slots: [] }) as { slots: string[] };
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
    notifyMac("Dodona: IBKR gateway logged out", `The ${slot} batch didn't run. Log in at https://localhost:5001 (or say "refresh IBKR").`);
    return "gateway not ready";
  }
  const r = await startLiveRun("live");
  return r.ok ? `started ${slot}` : `not started: ${r.error}`;
}

const NOTIFIED = () => join(dir(), "notified.json");

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
  notifyMac("Dodona: IBKR batch ready", `${syms}. Approve on the Desk (IBKR orders) within 15 minutes, or it expires.`);
}

/** While Dodona runs, check every minute: the batch times, a batch to announce, the daily review. Safe to call often. */
const TIMER_VERSION = 2; // bump when the tick changes, so a running Dodona swaps in the new one
export function ensureReviewScheduler() {
  if (g.__dodonaReviewTimer && g.__dodonaTimerVersion === TIMER_VERSION) return;
  if (g.__dodonaReviewTimer) clearInterval(g.__dodonaReviewTimer);
  g.__dodonaTimerVersion = TIMER_VERSION;
  g.__dodonaReviewTimer = setInterval(() => {
    void autoBatchTick().catch(() => undefined);
    void maybeStartReview().catch(() => undefined);
  }, 60_000);
  g.__dodonaReviewTimer.unref?.();
}
