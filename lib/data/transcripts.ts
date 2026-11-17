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

export interface AgentUsage {
  model?: string; // e.g. "claude-haiku-5-5", from the transcript
  calls: number; // model responses
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd?: number; // estimate at API list prices; undefined for a model not in PRICES
}

export interface TeamTranscript {
  file?: string;
  sessionId?: string;
  steps: TeamStep[];
  agents: Array<{ agent: string; steps: number; usage?: AgentUsage }>;
  /** What the session would have cost through the API (Claude Code itself uses the plan's usage). */
  costUsd?: number;
  note?: string;
}

/** API list prices per million tokens: input, output. Cache reads are 0.1x input, writes 1.25x (5 min) or 2x (1 hour). */
export const PRICES: Array<{ match: RegExp; input: number; output: number; label: string }> = [
  { match: /opus-5-5/, input: 4, output: 20, label: "Opus 5.5" },
  { match: /sonnet-5-5/, input: 2, output: 10, label: "Sonnet 5.5" },
  // Haiku 5.5 has two rate cards: prompts over 100K tokens cost 5x
  { match: /haiku-5-5/, input: 0.1, output: 0.5, label: "Haiku 5.5" },
];
export const modelLabel = (m?: string) => (m ? PRICES.find((p) => p.match.test(m))?.label ?? m.replace(/^claude-/, "") : undefined);

interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
}

/** Tokens and estimated API cost of these records. A response split over several records is counted once (by message id). */
export function usageFrom(recs: Rec[]): AgentUsage | undefined {
  const seen = new Set<string>();
  const u: AgentUsage = { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let cost = 0;
  let priced = true;
  for (const r of recs) {
    const m = r.message;
    if (m?.role !== "assistant" || !m.usage) continue;
    const id = m.id ?? `${r.timestamp}-${seen.size}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const x = m.usage;
    const input = x.input_tokens ?? 0;
    const read = x.cache_read_input_tokens ?? 0;
    const write = x.cache_creation_input_tokens ?? 0;
    const w1h = Math.min(write, x.cache_creation?.ephemeral_1h_input_tokens ?? 0);
    u.model ??= m.model;
    u.calls++;
    u.input += input;
    u.output += x.output_tokens ?? 0;
    u.cacheRead += read;
    u.cacheWrite += write;
    const p = PRICES.find((q) => q.match.test(m.model ?? ""));
    if (!p) {
      priced = false;
      continue;
    }
    const long = /haiku/.test(m.model ?? "") && input + read + write > 100_000 ? 5 : 1;
    const inP = (p.input * long) / 1e6;
    cost += input * inP + read * inP * 0.1 + (write - w1h) * inP * 1.25 + w1h * inP * 2 + (x.output_tokens ?? 0) * ((p.output * long) / 1e6);
  }
  if (!u.calls) return undefined;
  if (priced) u.costUsd = Math.round(cost * 10_000) / 10_000;
  return u;
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
  message?: { role?: string; content?: unknown; id?: string; model?: string; usage?: Usage };
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

/** The model each trade subagent is set to run on (the `model:` line of .claude/agents/trade-*.md). */
export async function teamModels(root = process.cwd()): Promise<Record<string, string>> {
  const dir = join(root, ".claude", "agents");
  const out: Record<string, string> = {};
  for (const f of await readdir(dir).catch(() => [] as string[])) {
    if (!/^trade-[a-z]+\.md$/.test(f)) continue;
    const m = (await readFile(join(dir, f), "utf8").catch(() => "")).match(/^---[\s\S]*?^model:\s*([\w.-]+)\s*$[\s\S]*?^---/m);
    if (m) out[f.replace(/\.md$/, "")] = m[1];
  }
  return out;
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
  const leadRecs = lead.recs.filter((r) => !r.isSidechain);
  const main = stepsFrom(leadRecs, "lead");
  const steps = [...main.steps];
  const usage = new Map<string, AgentUsage>();
  const addUsage = (agent: string, u?: AgentUsage) => {
    if (!u) return;
    const a = usage.get(agent);
    if (!a) return void usage.set(agent, { ...u });
    a.model ??= u.model;
    a.calls += u.calls;
    a.input += u.input;
    a.output += u.output;
    a.cacheRead += u.cacheRead;
    a.cacheWrite += u.cacheWrite;
    a.costUsd = a.costUsd !== undefined && u.costUsd !== undefined ? Math.round((a.costUsd + u.costUsd) * 10_000) / 10_000 : undefined;
  };
  // the lead's usage only from the session's own window: the main file also holds earlier, unrelated turns
  const t0 = Date.parse(leadRecs.find(startsSession)?.timestamp ?? startedAt) - 60_000;
  addUsage("lead", usageFrom(leadRecs.filter((r) => Date.parse(r.timestamp!) >= t0)));
  // each subagent file belongs to the delegate that started just before it
  const used = new Set<string>();
  for (const s of subs.sort((a, b) => Date.parse(a.recs[0].timestamp!) - Date.parse(b.recs[0].timestamp!))) {
    const t0 = Date.parse(s.recs[0].timestamp!);
    const d = [...main.delegates].reverse().find((x) => x.at <= t0 + 2_000 && !used.has(x.id));
    if (!d) continue;
    used.add(d.id);
    // skip the subagent's first user message (its prompt, already shown on the delegate step)
    addUsage(d.agent, usageFrom(s.recs));
    steps.push(...stepsFrom(s.recs.filter((r) => r.message?.role === "assistant" || (r.message!.content as Block[]).some((b) => b.type === "tool_result")), d.agent).steps);
  }
  steps.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const count = new Map<string, number>();
  for (const s of steps) count.set(s.agent, (count.get(s.agent) ?? 0) + 1);
  for (const a of usage.keys()) if (!count.has(a)) count.set(a, 0);
  const costs = [...usage.values()].map((u) => u.costUsd);
  return {
    file: lead.file.split("/").pop(),
    sessionId: lead.recs.find((r) => r.sessionId)?.sessionId,
    steps: steps.slice(-600),
    agents: [...count.entries()].map(([agent, n]) => ({ agent, steps: n, usage: usage.get(agent) })),
    costUsd: costs.length && costs.every((c) => c !== undefined) ? Math.round(costs.reduce((a, b) => a! + b!, 0)! * 100) / 100 : undefined,
  };
}
