// Server only. Starts the trade team as a background Claude Code session from the Desk's "Run desk
// now" button (when the team drives the desk), and reports how it's going: `/trade-desk live` (the
// LIVE MORNING batch for IBKR, when real orders are on) or `/trade-desk` (one paper cycle).
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

const dir = () => resolve(process.cwd(), "trader", "runs");
const STATE = () => join(dir(), "live-run.json");

interface RunState {
  pid: number;
  startedAt: string;
  log: string;
  mode?: RunMode;
}

export type RunMode = "live" | "paper";

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
  "Bash(python3 .claude/skills/:*)",
  "Bash(cd:*)",
  "Bash(python3 ../../.claude/skills/:*)",
  "Read",
  "Glob",
  "Grep",
  "Agent",
  "Task",
  "Skill",
];
const BLOCKED = ["Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch", "Bash(curl:*)", "Bash(wget:*)", "Bash(rm:*)", "Bash(git:*)"];
const NOTE =
  "You were started from Dodona's \"Run desk now\" button, with no one watching the chat. In LIVE MORNING mode your working directory is the repo root: run skill scripts as `python3 .claude/skills/<skill>/<script>.py …` (no cd), and tell every subagent the same, plus LIVE MORNING. In a paper cycle, skills run in trader/paper as usual (`cd trader/paper && python3 ../../.claude/skills/<skill>/<script>.py …`). Only stage, book on paper and check: never place, change or cancel an order (the user does that in Dodona). If a step needs the user (the gateway isn't logged in, it's outside the window), log it with `npm run desk -- log`, end the session, and stop.";

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
    ["-p", mode === "live" ? "/trade-desk live" : "/trade-desk", "--output-format", "stream-json", "--verbose", "--allowedTools", ...ALLOWED, "--disallowedTools", ...BLOCKED, "--append-system-prompt", NOTE],
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
