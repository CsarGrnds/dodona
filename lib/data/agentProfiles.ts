// Server-only. Reads and saves the trade team's profiles: each subagent's .claude/agents/trade-*.md,
// and the lead's /trade-desk SKILL.md (shown read-only: it holds the team's order rules). A save is
// checked by lib/agentProfile.ts, refused if the file changed since the page read it, and keeps one
// step of undo in trader/agent-undo/<agent>.md (trader/ is gitignored).
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { checkProfile, parseProfile, type AgentProfileView } from "@/lib/agentProfile";
import { TEAM } from "@/lib/settings";

export type { AgentProfileView };

const LEAD = { agent: "lead", label: "Lead trader", job: "Runs the cycle, hands out the work, books what Risk passes", file: ".claude/skills/trade-desk/SKILL.md" };
const fileOf = (agent: string) => (agent === "lead" ? LEAD.file : `.claude/agents/${agent}.md`);
const hashOf = (t: string) => createHash("sha256").update(t).digest("hex").slice(0, 16);
const UNDO_DIR = () => join(process.cwd(), "trader", "agent-undo"); // trader/ is gitignored

async function view(agent: string, label: string, job: string, editable: boolean): Promise<AgentProfileView> {
  const file = fileOf(agent);
  const p = join(process.cwd(), file);
  const text = await readFile(p, "utf8").catch(() => "");
  const fm = parseProfile(text);
  const st = await stat(p).catch(() => null);
  return { agent, label, job, file, editable, model: fm?.model, tools: fm?.tools ?? [], description: fm?.description, text, hash: hashOf(text), modified: st?.mtime.toISOString() };
}

export async function listProfiles(): Promise<AgentProfileView[]> {
  return Promise.all([view(LEAD.agent, LEAD.label, LEAD.job, false), ...TEAM.map((t) => view(t.agent, t.label, t.job, true))]);
}

export type SaveProfileResult = { ok: true; profile: AgentProfileView } | { ok: false; errors: string[]; conflict?: boolean };

export async function saveProfile(agent: string, text: string, base: string): Promise<SaveProfileResult> {
  const t = TEAM.find((x) => x.agent === agent);
  if (!t) return { ok: false, errors: [agent === "lead" ? "The lead's /trade-desk skill holds the team's order rules: edit it in Claude Code, not here." : "not a trade team agent"] };
  const p = join(process.cwd(), fileOf(agent));
  const saved = await readFile(p, "utf8");
  if (hashOf(saved) !== base) return { ok: false, conflict: true, errors: ["The file changed since you opened it (Settings or Claude Code saved it). Reload to see the new version."] };
  const next = text.replace(/\r\n/g, "\n").replace(/\n*$/, "\n");
  const errors = checkProfile(agent, next, saved);
  if (errors.length) return { ok: false, errors };
  if (next !== saved) {
    await mkdir(UNDO_DIR(), { recursive: true });
    await writeFile(join(UNDO_DIR(), `${agent}.md`), saved); // one step of undo
    const tmp = `${p}.tmp`;
    await writeFile(tmp, next);
    await rename(tmp, p);
  }
  return { ok: true, profile: await view(agent, t.label, t.job, true) };
}
