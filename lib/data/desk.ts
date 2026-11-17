// Server-only: the paper desk's ledger (trader/desk.json) and the rules (trader/config.json).
// Both live in trader/, which is gitignored: nothing here is ever committed.
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
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

// One writer at a time: two tabs auto-running, or the page and `npm run desk`, must not
// double-trade. In-process queue plus a lock file across processes (stale after 5 minutes).
let chain: Promise<unknown> = Promise.resolve();
const LOCK_STALE_MS = 5 * 60_000;

async function fileLock(): Promise<() => Promise<void>> {
  const p = `${deskPath()}.lock`;
  await mkdir(dirname(p), { recursive: true });
  for (let i = 0; i < 600; i++) {
    try {
      const fh = await open(p, "wx");
      await fh.writeFile(`${process.pid} ${new Date().toISOString()}\n`);
      await fh.close();
      return async () => {
        await unlink(p).catch(() => undefined);
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const st = await stat(p).catch(() => null);
      if (st && Date.now() - st.mtimeMs > LOCK_STALE_MS) await unlink(p).catch(() => undefined);
      else await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error("the desk ledger is busy (trader/desk.json.lock): try again in a moment");
}

export function withDeskLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = async () => {
    const release = await fileLock();
    try {
      return await fn();
    } finally {
      await release();
    }
  };
  const next = chain.then(run, run);
  chain = next.catch(() => undefined);
  return next;
}
