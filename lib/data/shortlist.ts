// Server only. The day's pre-market shortlist (lib/shortlist.ts's rules) over the whole universe,
// from Yahoo's daily spark feed (20 symbols a request), written to trader/shortlist.json. The
// `trade-prep` agent then checks news on the best ones and drops AVOIDs with dropFromShortlist.
// The live runs' `desk pending` scan looks only at today's kept names when the file is today's.
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { countReasons, isPick, rankShortlist, return20, screenDaily, type Screened, type ShortlistPick } from "../shortlist";
import { nyClock } from "../setups";
import { pool, spark, SPARK_MAX, type Spark } from "./pending";

export interface Shortlist {
  date: string; // New York date it is for
  built_at: string;
  universe: number;
  fetched: number;
  spyReturn20?: number;
  kept: ShortlistPick[];
  dropped: Array<{ symbol: string; why: string; at: string; by?: string }>; // by news (trade-prep), with the reason
  reasons: Record<string, number>; // why the rest of the market was left out, how many
}

const FILE = () => resolve(process.cwd(), "trader", "shortlist.json");

/** Completed sessions only: today's (partial) daily bar is left out. */
const completed = (s: Spark, today: string) => s.closes.filter((c, i) => Number.isFinite(c) && nyClock(s.t[i]).date < today);

export async function buildShortlist(opts: { maxPrice: number; exclude?: string[]; keep?: number; nowMs?: number }): Promise<Shortlist> {
  const nowMs = opts.nowMs ?? Date.now();
  const { date } = nyClock(nowMs);
  const text = await readFile(resolve(process.cwd(), "trader", "universe.txt"), "utf8").catch(() => "");
  const universe = text.split("\n").map((l) => l.split("|")[0].trim().toUpperCase()).filter((s) => /^[A-Z][A-Z0-9.]{0,6}$/.test(s));
  if (!universe.length) throw new Error("trader/universe.txt is missing: run the scanner's `scan.py universe` once");
  const exclude = new Set((opts.exclude ?? []).map((s) => s.toUpperCase()));
  const syms = universe.filter((s) => !exclude.has(s));
  const batches: string[][] = [];
  for (let i = 0; i < syms.length; i += SPARK_MAX) batches.push(syms.slice(i, i + SPARK_MAX));
  const data = Object.assign({}, ...(await pool(batches, 8, (b) => spark(b, "6mo", "1d").catch(() => ({}))))) as Record<string, Spark>;
  const spy = (await spark(["SPY"], "6mo", "1d").catch(() => ({}) as Record<string, Spark>)).SPY;
  const spyReturn20 = spy ? return20(completed(spy, date)) ?? undefined : undefined;
  const screened: Screened[] = Object.entries(data).map(([sym, s]) => screenDaily(sym, completed(s, date), s.volume, { maxPrice: opts.maxPrice, spyReturn20 }));
  const doc: Shortlist = {
    date,
    built_at: new Date(nowMs).toISOString(),
    universe: universe.length,
    fetched: Object.keys(data).length,
    ...(spyReturn20 === undefined ? {} : { spyReturn20: Math.round(spyReturn20 * 100) / 100 }),
    kept: rankShortlist(screened.filter(isPick)).slice(0, opts.keep ?? 40),
    dropped: [],
    reasons: countReasons(screened),
  };
  await writeFile(FILE(), JSON.stringify(doc, null, 2) + "\n");
  return doc;
}

export async function readShortlist(): Promise<Shortlist | null> {
  return JSON.parse(await readFile(FILE(), "utf8").catch(() => "null"));
}

/** Today's kept symbols, or null when there's no shortlist for today. */
export async function todaysShortlist(nowMs = Date.now()): Promise<string[] | null> {
  const doc = await readShortlist();
  return doc && doc.date === nyClock(nowMs).date ? doc.kept.map((k) => k.symbol) : null;
}

/** Take a name off today's shortlist, with the reason (trade-prep: AVOID news, earnings). */
export async function dropFromShortlist(symbol: string, why: string, by = "news"): Promise<Shortlist> {
  const doc = await readShortlist();
  if (!doc) throw new Error("no shortlist yet: run `npm run desk -- shortlist build` first");
  const sym = symbol.toUpperCase();
  if (!doc.kept.some((k) => k.symbol === sym)) throw new Error(`${sym} isn't on the shortlist`);
  doc.kept = doc.kept.filter((k) => k.symbol !== sym);
  doc.dropped.push({ symbol: sym, why, at: new Date().toISOString(), by });
  await writeFile(FILE(), JSON.stringify(doc, null, 2) + "\n");
  return doc;
}
