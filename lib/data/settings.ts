// Server-only. Reads and saves the trading settings: the rules in trader/config.json (shared by every
// /trader-* skill and Dodona's desk), each trade subagent's model (.claude/agents/trade-*.md) and who
// makes the desk's entries (the ledger's driver). Keys the page doesn't edit (paper, margin, shorts,
// options, broker…) are kept exactly as they are.
import { copyFile, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_DESK_RULES } from "@/lib/desk";
import { deskAgentEnabled, deskModel } from "@/lib/deskAgent";
import { AGENT_MODELS, LOCKED, TEAM, validateRules, type AgentModel } from "@/lib/settings";
import { nyClock } from "@/lib/setups";
import { configPath, loadOrCreateDesk, readDesk, readDeskRules, withDeskLock, writeDesk } from "./desk";
import { writePaperWorkspace } from "./paper";
import { teamModels } from "./transcripts";

const EXAMPLE = () => join(process.cwd(), ".claude", "skills", "trader-budget", "config.example.json");
const agentFile = (agent: string) => join(process.cwd(), ".claude", "agents", `${agent}.md`);

async function readConfigRaw(): Promise<{ cfg: Record<string, unknown>; fromFile: boolean }> {
  try {
    return { cfg: JSON.parse(await readFile(configPath(), "utf8")), fromFile: true };
  } catch {
    const example = await readFile(EXAMPLE(), "utf8").then(JSON.parse).catch(() => ({}));
    return { cfg: { ...DEFAULT_DESK_RULES, max_orders_per_day: 10, paper: true, ...example }, fromFile: false };
  }
}

export async function readSettings() {
  const { cfg, fromFile } = await readConfigRaw();
  const desk = await readDesk().catch(() => null);
  return {
    rules: { ...DEFAULT_DESK_RULES, max_orders_per_day: 10, broker: "alpaca", ibkr_orders: false, ...cfg },
    locked: LOCKED.map((l) => ({ ...l, value: cfg[l.key] ?? l.safe })),
    fromFile,
    file: "trader/config.json",
    models: await teamModels(),
    driver: desk?.driver ?? "auto",
    deskAgent: { enabled: deskAgentEnabled(), model: deskModel() },
  };
}

export interface SettingsPatch {
  rules?: Record<string, unknown>;
  models?: Record<string, string>;
  driver?: string;
}

export type SaveResult = { ok: true; saved: string[] } | { ok: false; errors: Record<string, string> };

export async function saveSettings(patch: SettingsPatch): Promise<SaveResult> {
  const errors: Record<string, string> = {};
  let rules: Record<string, unknown> | undefined;
  if (patch.rules) {
    const v = validateRules(patch.rules);
    if (!v.ok) Object.assign(errors, v.errors);
    else rules = v.values;
  }
  const models: Array<[string, AgentModel]> = [];
  for (const [agent, m] of Object.entries(patch.models ?? {})) {
    if (!TEAM.some((t) => t.agent === agent)) errors[`model:${agent}`] = "not a trade team agent";
    else if (!(AGENT_MODELS as readonly string[]).includes(m)) errors[`model:${agent}`] = `one of ${AGENT_MODELS.join(", ")}`;
    else models.push([agent, m as AgentModel]);
  }
  if (patch.driver !== undefined && patch.driver !== "team" && patch.driver !== "auto") errors.driver = "team or auto";
  if (Object.keys(errors).length) return { ok: false, errors };

  const saved: string[] = [];
  if (rules && Object.keys(rules).length) {
    const { cfg, fromFile } = await readConfigRaw();
    const next = { ...cfg, ...rules };
    if (fromFile) await copyFile(configPath(), configPath().replace(/\.json$/, ".prev.json")); // one step of undo
    const tmp = `${configPath()}.tmp`;
    await writeFile(tmp, JSON.stringify(next, null, 2) + "\n");
    await rename(tmp, configPath());
    saved.push("rules");
  }
  for (const [agent, m] of models) {
    const p = agentFile(agent);
    const text = await readFile(p, "utf8");
    const out = text.replace(/^(---[\s\S]*?^model:[ \t]*)[\w.-]+/m, `$1${m}`);
    if (out === text && !/^model:/m.test(text)) throw new Error(`${agent}.md has no model line`);
    if (out !== text) {
      await writeFile(p, out);
      saved.push(`model:${agent}`);
    }
  }
  if (saved.includes("rules") || patch.driver) {
    // keep the paper workspace the trade team runs in (trader/paper/) in step with the new rules
    await withDeskLock(async () => {
      const { rules: r } = await readDeskRules();
      const s = await loadOrCreateDesk(r);
      if (patch.driver && s.driver !== patch.driver) {
        s.driver = patch.driver as "team" | "auto";
        saved.push("driver");
      }
      await writeDesk(s);
      await writePaperWorkspace(s, nyClock(Date.now()).date);
    });
  }
  return { ok: true, saved };
}
