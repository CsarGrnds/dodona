// Server-only. Paper mode ("paper" in trader/config.json) is the one switch between fake and real money:
//   on  — practice: Dodona's $-ledger desk shows and runs (paper cycles, auto-runs), and IBKR orders
//         may only go to a paper account (DU…);
//   off — real money: no practice runs (they'd spend tokens on fake trades), nothing about the ledger
//         shows, and approved batches go to the real IBKR account.
// Only the user changes it, by clicking in Settings (turning it off asks them to type REAL MONEY).
// Claude never calls setPaperMode.
import { copyFile, readFile, rename, writeFile } from "node:fs/promises";
import { configPath } from "./desk";

export const REAL_MONEY_CONFIRM = "REAL MONEY";

async function readCfg(): Promise<Record<string, unknown> | undefined> {
  return readFile(configPath(), "utf8").then(JSON.parse).catch(() => undefined);
}

/** Practice (paper) mode: on unless the config says "paper": false. */
export async function practiceOn(): Promise<boolean> {
  const cfg = await readCfg();
  return cfg?.paper !== false;
}

export const PRACTICE_OFF = "Practice is off: paper mode is off in Settings, so Dodona trades real money only and runs no practice trades.";

/** The user's click in Settings. Turning paper off (real money) needs their typed confirmation. */
export async function setPaperMode(paper: boolean, typed = ""): Promise<{ ok: boolean; error?: string; paper?: boolean }> {
  const cfg = await readCfg();
  if (!cfg) return { ok: false, error: "trader/config.json is missing; save your rules in Settings first." };
  if (!paper && typed.trim().toUpperCase() !== REAL_MONEY_CONFIRM) return { ok: false, error: `Type ${REAL_MONEY_CONFIRM} to turn paper mode off.` };
  if ((cfg.paper !== false) === paper) return { ok: true, paper };
  await copyFile(configPath(), configPath().replace(/\.json$/, ".prev.json")); // one step of undo
  const tmp = `${configPath()}.tmp`;
  await writeFile(tmp, JSON.stringify({ ...cfg, paper }, null, 2) + "\n");
  await rename(tmp, configPath());
  return { ok: true, paper };
}
