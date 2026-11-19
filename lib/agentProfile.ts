// Pure. A trade team agent's profile is its Claude Code subagent file, .claude/agents/trade-*.md:
// YAML-ish frontmatter (name, description, tools, model) and the instructions it follows. Dodona's
// Agents page lets you edit it; these checks keep the edits from breaking the team or its safety rules.
import { AGENT_MODELS } from "./settings";

export interface Profile {
  name?: string;
  description?: string;
  tools: string[];
  model?: string;
  body: string;
}

/** One profile as the Agents page shows it (lib/data/agentProfiles.ts reads it). */
export interface AgentProfileView {
  agent: string;
  label: string;
  job: string;
  file: string; // repo-relative
  editable: boolean;
  model?: string;
  tools: string[];
  description?: string;
  text: string;
  hash: string;
  modified?: string;
}

export const PROFILE_MAX = 64_000;
/** Tools a trade agent may have. Edit/Write only for the coach, who writes the playbook (AGENTS.md). */
export const READ_TOOLS = ["Bash", "Read", "Glob", "Grep"] as const;
export const WRITERS = new Set(["trade-coach"]);

/** Split a profile into its frontmatter fields and body. */
export function parseProfile(text: string): Profile | null {
  const m = text.replace(/\r\n/g, "\n").match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return null;
  const field = (k: string) => m[1].match(new RegExp(`^${k}:[ \\t]*(.*)$`, "m"))?.[1].trim();
  const tools = (field("tools") ?? "").split(",").map((t) => t.trim()).filter(Boolean);
  return { name: field("name"), description: field("description"), tools, model: field("model"), body: m[2] };
}

/** The ground rule that keeps every agent away from orders: the "- NEVER AN ORDER" bullet, as written. */
export function orderRule(text: string): string | undefined {
  const m = text.replace(/\r\n/g, "\n").match(/^- NEVER AN ORDER\.[\s\S]*?(?=\n- |\n\n|\n#|$)/m);
  return m?.[0];
}

/**
 * Check an edited profile against the saved one. Returns the problems in plain words (empty = OK).
 * - the frontmatter must parse and keep the agent's name (Claude Code finds the agent by it)
 * - the model must be one Settings knows
 * - tools: only Bash, Read, Glob, Grep (plus Edit, Write for the coach); nothing that reaches the web
 * - the "NEVER AN ORDER" ground rule stays word for word
 */
export function checkProfile(agent: string, text: string, saved: string): string[] {
  const errs: string[] = [];
  if (text.length > PROFILE_MAX) errs.push(`too long: keep it under ${PROFILE_MAX / 1000}k characters`);
  const p = parseProfile(text);
  if (!p) return [...errs, "the file must start with the --- frontmatter block (name, description, tools, model) and close it with ---"];
  if (p.name !== agent) errs.push(`name: must stay "${agent}" (Claude Code calls the agent by it)`);
  if (!p.description) errs.push("description: say what the agent does and when the lead should use it");
  if (!p.model || !(AGENT_MODELS as readonly string[]).includes(p.model)) errs.push(`model: one of ${AGENT_MODELS.join(", ")}`);
  const allowed = new Set<string>([...READ_TOOLS, ...(WRITERS.has(agent) ? ["Edit", "Write"] : [])]);
  const extra = p.tools.filter((t) => !allowed.has(t));
  if (!p.tools.length) errs.push("tools: list at least one (Bash, Read, Glob, Grep)");
  if (extra.length) errs.push(`tools: ${extra.join(", ")} not allowed; a trade agent may use ${[...allowed].join(", ")}`);
  if (!p.body.trim()) errs.push("the instructions below the frontmatter are empty");
  const rule = orderRule(saved);
  if (rule && !text.replace(/\r\n/g, "\n").includes(rule)) errs.push('the "NEVER AN ORDER" ground rule must stay exactly as it is');
  return errs;
}
