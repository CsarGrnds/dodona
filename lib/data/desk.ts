// Server-only: the paper desk's ledger (trader/desk.json) and the rules (trader/config.json).
// Both live in trader/, which is gitignored: nothing here is ever committed.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { newDesk, normalizeDeskRules, parseDesk, type DeskRules, type DeskState } from "../desk";

export const deskPath = () => resolve(process.cwd(), process.env.DODONA_DESK ?? "trader/desk.json");
export const configPath = () => resolve(process.cwd(), "trader/config.json");

export async function readDeskRules(): Promise<{ rules: DeskRules; fromFile: boolean }> {
  try {
    return { rules: normalizeDeskRules(JSON.parse(await readFile(configPath(), "utf8"))), fromFile: true };
  } catch {
    return { rules: normalizeDeskRules({}), fromFile: false };
  }
}

export async function readDesk(): Promise<DeskState | null> {
  try {
    return parseDesk(JSON.parse(await readFile(deskPath(), "utf8")));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

export async function writeDesk(s: DeskState) {
  const p = deskPath();
  await mkdir(dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  await writeFile(tmp, JSON.stringify(s, null, 1) + "\n");
  await rename(tmp, p); // atomic: a crash never leaves half a ledger
}

export async function loadOrCreateDesk(rules: DeskRules): Promise<DeskState> {
  return (await readDesk()) ?? newDesk(rules.budget, new Date().toISOString());
}

// One run at a time: two tabs auto-running must not double-trade.
let chain: Promise<unknown> = Promise.resolve();
export function withDeskLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
}
