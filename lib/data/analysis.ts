// Server-only: reads what the trade team analyzed (trader/learning/candidates.jsonl), the charts the
// chartist drew (trader/charts), the coach's replays (trader/learning/reviews) and the IBKR tickets
// (trader/staged.json, trader/state/broker.json) for the Desk's "Today's analysis" board. Read-only.
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildAnalysis, CHART_FILE, parseChart, type Analysis, type ChartRef, type Ticket } from "@/lib/analysis";
import type { Candidate } from "@/lib/learning";
import { nyClock } from "@/lib/setups";

const root = (...p: string[]) => resolve(process.cwd(), "trader", ...p);
const readJson = async (p: string) => JSON.parse(await readFile(p, "utf8").catch(() => "null"));
export const chartsDir = () => root("charts");

export async function readAnalysis(date?: string): Promise<Analysis> {
  const candidates: Candidate[] = (await readFile(root("learning", "candidates.jsonl"), "utf8").catch(() => ""))
    .split("\n")
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as Candidate];
      } catch {
        return [];
      }
    });
  const charts = (await readdir(chartsDir()).catch(() => [] as string[])).map(parseChart).filter((c): c is ChartRef => !!c);
  const day = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : [...new Set(candidates.map((c) => c.date))].sort().pop();
  const review = day ? await readJson(root("learning", "reviews", `${day}.json`)) : null;

  // tickets: the staged batch (today only), then what happened to each order at IBKR (the log wins)
  const tickets: Record<string, Ticket> = {};
  const staged = await readJson(root("staged.json"));
  if (day && staged?.updated_at && nyClock(Date.parse(staged.updated_at)).date === day) {
    for (const o of (staged.orders ?? []) as Array<Record<string, unknown>>) {
      const plan = (o.plan ?? {}) as Record<string, unknown>;
      const qty = Number(o.qty);
      const trigger = Number(o.stop_price ?? plan.entry);
      tickets[String(o.symbol).toUpperCase()] = { status: "staged", qty, trigger, cost: Math.round(qty * trigger * 100) / 100, ...(plan.max_loss !== undefined ? { maxLoss: Number(plan.max_loss) } : {}) };
    }
  }
  const broker = await readJson(root("state", "broker.json"));
  for (const r of ((broker?.orders ?? []) as Array<Record<string, unknown>>).filter((x) => x.broker === "ibkr" && x.date === day && String(x.side).toLowerCase() === "buy")) {
    const sym = String(r.symbol).toUpperCase();
    const prev = tickets[sym];
    if (prev?.at && Date.parse(prev.at) > Date.parse(String(r.at))) continue;
    tickets[sym] = {
      ...prev,
      status: r.status as Ticket["status"],
      at: String(r.at),
      ...(r.qty !== undefined ? { qty: Number(r.qty) } : {}),
      ...(r.cost !== undefined ? { cost: Number(r.cost) } : {}),
      ...(r.max_loss !== undefined ? { maxLoss: Number(r.max_loss) } : {}),
    };
  }

  return buildAnalysis({ candidates, charts, replays: review?.replays ?? [], tickets, date: day });
}

/** A chart PNG by its file name (strict pattern: no paths). */
export async function readChart(file: string): Promise<Buffer | undefined> {
  if (!CHART_FILE.test(file)) return undefined;
  return readFile(resolve(chartsDir(), file)).catch(() => undefined);
}
