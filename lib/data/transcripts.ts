// Server-only: reads the Claude Code session transcripts of the /trade-desk team from
// ~/.claude/projects/<this project>/ so the Desk page can show everything the team did:
// the lead's reasoning and commands, each subagent it sent out, their own skill runs and
// their reports. Read-only and local: the files never leave this machine.
//
// The transcript format is Claude Code's internal one and isn't documented, so this reader is
// defensive: it only relies on records with a `timestamp` and a `message.content` array of
// text / thinking / tool_use / tool_result blocks, and skips anything else.
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface TeamStep {
  at: string;
  agent: string; // "lead" or the subagent type, e.g. "trade-timemachine"
  kind: "thinking" | "text" | "command" | "output" | "delegate" | "report" | "skill" | "tool";
  title: string;
  detail?: string;
  ok?: boolean;
}

export interface TeamTranscript {
  file?: string;
  sessionId?: string;
  steps: TeamStep[];
  agents: Array<{ agent: string; steps: number }>;
  note?: string;
}

const DETAIL_MAX = 2500;
const cut = (s: string, n = DETAIL_MAX) => (s.length > n ? `${s.slice(0, n)}…` : s);

export const projectSlug = (cwd = process.cwd()) => cwd.replace(/[^a-zA-Z0-9]/g, "-");
export const projectDir = () => process.env.CLAUDE_PROJECTS_DIR ? join(process.env.CLAUDE_PROJECTS_DIR, projectSlug()) : join(homedir(), ".claude", "projects", projectSlug());

interface Block {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
  id?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}
interface Rec {
  type?: string;
  timestamp?: string;
  sessionId?: string;
  isSidechain?: boolean;
  agentId?: string;
  message?: { role?: string; content?: unknown };
}

function resultText(c: unknown): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((b) => (typeof b === "string" ? b : (b as Block)?.type === "text" ? (b as Block).text ?? "" : "")).join("\n");
  return "";
}

function parseLines(text: string, from: number, to: number): Rec[] {
  const out: Rec[] = [];
  for (const line of text.split("\n")) {
    if (!line || line.length > 2_000_000) continue;
    // cheap time filter before JSON.parse: most lines carry "timestamp":"…"
    const m = line.match(/"timestamp":"([^"]+)"/);
    if (m) {
      const t = Date.parse(m[1]);
      if (t < from || t > to) continue;
    } else continue;
    try {
      const r = JSON.parse(line) as Rec;
      if (r.message && Array.isArray(r.message.content)) out.push(r);
    } catch {
      /* skip */
    }
  }
  return out;
}

/** Turn transcript records into steps. `agent` names whose work this is. */
export function stepsFrom(recs: Rec[], agent: string): { steps: TeamStep[]; delegates: Array<{ id: string; at: number; agent: string }> } {
  const steps: TeamStep[] = [];
  const delegates: Array<{ id: string; at: number; agent: string }> = [];
  const pending = new Map<string, { kind: "agent" | "bash" | "other"; agent?: string; title: string }>();
  for (const r of recs) {
    const at = r.timestamp!;
    for (const b of r.message!.content as Block[]) {
      if (b.type === "thinking" && b.thinking?.trim()) steps.push({ at, agent, kind: "thinking", title: "Thinking", detail: cut(b.thinking.trim()) });
      else if (b.type === "text" && r.message!.role === "assistant" && b.text?.trim()) steps.push({ at, agent, kind: "text", title: cut(b.text.trim().split("\n")[0], 140), detail: b.text.trim().includes("\n") ? cut(b.text.trim()) : undefined });
      else if (b.type === "tool_use" && b.id) {
        const inp = b.input ?? {};
        if (b.name === "Agent" || b.name === "Task") {
          const who = String(inp.subagent_type ?? inp.name ?? "subagent");
          steps.push({ at, agent, kind: "delegate", title: `→ ${who}: ${String(inp.description ?? "task")}`, detail: cut(String(inp.prompt ?? ""), 1200) });
          pending.set(b.id, { kind: "agent", agent: who, title: who });
          delegates.push({ id: b.id, at: Date.parse(at), agent: who });
        } else if (b.name === "Bash") {
          const cmd = String(inp.command ?? "");
          const skill = cmd.match(/skills\/(trader-[a-z]+)\/([a-z_]+\.py)(?:\s+([a-z]+)\b)?/);
          const desk = cmd.match(/npm run (?:-s )?desk -- ([a-z]+(?: [a-z]+)?)/);
          const title = skill ? `/${skill[1]} · ${skill[2]}${skill[3] ? ` ${skill[3]}` : ""}` : desk ? `desk ${desk[1]}` : String(inp.description ?? cmd.split("\n")[0]).slice(0, 120);
          steps.push({ at, agent, kind: skill ? "skill" : "command", title, detail: cut(cmd, 800) });
          pending.set(b.id, { kind: "bash", title });
        } else {
          const title = b.name === "Skill" ? `Skill /${String(inp.skill ?? "")}` : b.name === "Read" ? `Read ${String(inp.file_path ?? "").split("/").slice(-3).join("/")}` : String(b.name ?? "tool");
          steps.push({ at, agent, kind: "tool", title });
          pending.set(b.id, { kind: "other", title });
        }
      } else if (b.type === "tool_result" && b.tool_use_id) {
        const p = pending.get(b.tool_use_id);
        if (!p) continue;
        const txt = resultText(b.content).trim();
        if (p.kind === "agent") steps.push({ at, agent: p.agent!, kind: "report", title: `${p.agent} reported`, detail: cut(txt), ok: !b.is_error });
        else if (p.kind === "bash") steps.push({ at, agent, kind: "output", title: `${p.title} → ${b.is_error ? "error" : "done"}`, detail: cut(txt), ok: !b.is_error });
      }
    }
  }
  return { steps, delegates };
}

/** A record where the lead ran `npm run desk -- session start` (the /trade-desk cycle's first step). */
const startsSession = (r: Rec) =>
  (r.message?.content as Block[]).some((b) => b.type === "tool_use" && b.name === "Bash" && /npm run (?:-s )?desk -- session start/.test(String(b.input?.command ?? "")));

async function jsonlFiles(dir: string, depth = 0): Promise<string[]> {
  const out: string[] = [];
  let ents: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }> = [];
  try {
    ents = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of ents) {
    const p = join(dir, e.name);
    if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
    else if (e.isDirectory() && depth < 3 && e.name !== "memory" && e.name !== "tool-results") out.push(...(await jsonlFiles(p, depth + 1)));
  }
  return out;
}

/**
 * The team's work between `startedAt` and `endedAt`: the lead's transcript (the main session file
 * that ran `npm run desk -- session start` in that window) and every subagent transcript in it.
 */
export async function readTeamTranscript(startedAt: string, endedAt?: string): Promise<TeamTranscript> {
  const dir = projectDir();
  const from = Date.parse(startedAt) - 3 * 60_000;
  const to = endedAt ? Date.parse(endedAt) + 2 * 60_000 : Date.now() + 60_000;
  const files = await jsonlFiles(dir);
  if (!files.length) return { steps: [], agents: [], note: `No Claude Code transcripts found in ${dir}.` };
  const recent: string[] = [];
  for (const f of files) {
    const st = await stat(f).catch(() => null);
    if (st && st.mtimeMs >= from && st.size < 200_000_000) recent.push(f);
  }
  let lead: { file: string; recs: Rec[] } | undefined;
  const subs: Array<{ file: string; recs: Rec[] }> = [];
  for (const f of recent) {
    const text = await readFile(f, "utf8").catch(() => "");
    const recs = parseLines(text, from, to);
    if (!recs.length) continue;
    const side = recs.every((r) => r.isSidechain) || /subagents|\/agent-[^/]+\.jsonl$/.test(f);
    if (side) subs.push({ file: f, recs });
    else if (!lead && recs.some(startsSession)) lead = { file: f, recs };
  }
  if (!lead) return { steps: [], agents: [], note: "The team's Claude Code session wasn't found yet (it appears once /trade-desk has started)." };
  const main = stepsFrom(lead.recs.filter((r) => !r.isSidechain), "lead");
  const steps = [...main.steps];
  // each subagent file belongs to the delegate that started just before it
  const used = new Set<string>();
  for (const s of subs.sort((a, b) => Date.parse(a.recs[0].timestamp!) - Date.parse(b.recs[0].timestamp!))) {
    const t0 = Date.parse(s.recs[0].timestamp!);
    const d = [...main.delegates].reverse().find((x) => x.at <= t0 + 2_000 && !used.has(x.id));
    if (!d) continue;
    used.add(d.id);
    // skip the subagent's first user message (its prompt, already shown on the delegate step)
    steps.push(...stepsFrom(s.recs.filter((r) => r.message?.role === "assistant" || (r.message!.content as Block[]).some((b) => b.type === "tool_result")), d.agent).steps);
  }
  steps.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const count = new Map<string, number>();
  for (const s of steps) count.set(s.agent, (count.get(s.agent) ?? 0) + 1);
  return {
    file: lead.file.split("/").pop(),
    sessionId: lead.recs.find((r) => r.sessionId)?.sessionId,
    steps: steps.slice(-600),
    agents: [...count.entries()].map(([agent, n]) => ({ agent, steps: n })),
  };
}
