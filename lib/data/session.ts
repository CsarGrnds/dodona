// The latest trading session, read from the team's logs in trader/ (read-only).
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Candidate, Replay } from "@/lib/learning";
import { fitFor } from "@/lib/budget";
import { buildSession, latestSessionDate, type SessionSummary } from "@/lib/session";

const ROOT = () => join(process.cwd(), "trader");
const json = (p: string) => readFile(p, "utf8").then(JSON.parse).catch(() => undefined);

export async function latestSession(): Promise<SessionSummary | undefined> {
  const candidates: Candidate[] = [];
  const raw = await readFile(join(ROOT(), "learning", "candidates.jsonl"), "utf8").catch(() => "");
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      candidates.push(JSON.parse(line));
    } catch {
      /* skip a torn line */
    }
  }
  const broker = await json(join(ROOT(), "state", "broker.json"));
  const orders = Array.isArray(broker?.orders) ? broker.orders : [];
  const shortlist = await json(join(ROOT(), "shortlist.json"));
  const date = latestSessionDate([...candidates.map((c) => c.date), ...orders.map((o: { date?: string }) => o.date ?? ""), shortlist?.date ?? ""]);
  if (!date) return undefined;
  const dir = join(ROOT(), "learning", "reviews");
  const rev = await json(join(dir, `${date}.json`));
  const history: Replay[] = [];
  for (const f of (await readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith(".json"))) history.push(...((await json(join(dir, f)))?.replays ?? []));
  const scans = (await readFile(join(ROOT(), "runs", `scans-${date}.jsonl`), "utf8").catch(() => ""))
    .split("\n")
    .flatMap((l) => {
      try {
        return l.trim() ? [JSON.parse(l)] : [];
      } catch {
        return [];
      }
    });
  const s = buildSession(date, { scans, candidates, replays: (rev?.replays ?? []) as Replay[], reviewedAt: rev?.reviewed_at, history, orders, shortlist });
  const cfg = await json(join(ROOT(), "config.json"));
  return cfg ? { ...s, fit: fitFor(cfg) } : s;
}
