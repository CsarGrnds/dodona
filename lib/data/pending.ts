// Server only. The "formed but not broken" opening-range scan over the whole market, fast:
//   stage 1: Yahoo's spark feed, 20 symbols a request, today's 5-minute closes for every stock in
//            trader/universe.txt (the scanner's list), filtered by price and dollar volume, and kept
//            only if no close is above the first 15 minutes' closes yet (a rough first cut);
//   stage 2: the full 5-minute bars (highs, lows, volume) for the most-traded survivors, checked with
//            lib/pending.ts's exact rules.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { dailyTrend, isPending, pendingRange, rankPending, type PendingRange } from "../pending";
import { nyClock } from "../setups";
import { getDailyHistory, getIntraday } from "./index";

const UA = "Mozilla/5.0 (compatible; Dodona/0.1)";
export const SPARK_MAX = 20;

export interface Spark {
  closes: number[];
  t: number[];
  price?: number;
  volume?: number;
}

export async function spark(symbols: string[], range = "1d", interval = "5m"): Promise<Record<string, Spark>> {
  const url = `https://query1.finance.yahoo.com/v7/finance/spark?symbols=${symbols.map((s) => s.replace(".", "-")).join(",")}&range=${range}&interval=${interval}`;
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "*/*" }, cache: "no-store" });
  if (!res.ok) throw new Error(`spark ${res.status}`);
  const doc = (await res.json()) as { spark?: { result?: Array<{ symbol?: string; response?: Array<Record<string, unknown>> }> } };
  const out: Record<string, Spark> = {};
  for (const item of doc.spark?.result ?? []) {
    const r = item.response?.[0];
    if (!r) continue;
    const q = (((r.indicators as Record<string, unknown>)?.quote as Array<Record<string, unknown>>) ?? [])[0] ?? {};
    const meta = (r.meta ?? {}) as Record<string, unknown>;
    const closes = ((q.close as Array<number | null>) ?? []).map((c) => (typeof c === "number" ? c : NaN));
    out[String(item.symbol ?? "").toUpperCase().replace("-", ".")] = { closes, t: ((r.timestamp as number[]) ?? []).map((s) => s * 1000), price: typeof meta.regularMarketPrice === "number" ? meta.regularMarketPrice : undefined, volume: typeof meta.regularMarketVolume === "number" ? meta.regularMarketVolume : undefined };
  }
  return out;
}

export async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]);
      }
    }),
  );
  return out;
}

export interface PendingScan {
  at: string;
  universe: number;
  stage1: number; // passed price, liquidity and the rough not-broken check
  confirmed: number; // checked with full bars
  pending: PendingRange[];
  rejected: Record<string, number>; // why, how many (stage 2)
}

export async function scanPending(opts: { symbols?: string[]; minRangePct?: number; maxPrice: number; minPrice?: number; minDollarVolume?: number; confirm?: number; limit?: number; exclude?: string[]; nowMs?: number }): Promise<PendingScan> {
  const nowMs = opts.nowMs ?? Date.now();
  const text = await readFile(resolve(process.cwd(), "trader", "universe.txt"), "utf8").catch(() => "");
  const universe = text.split("\n").map((l) => l.split("|")[0].trim().toUpperCase()).filter((s) => /^[A-Z][A-Z0-9.]{0,6}$/.test(s));
  if (!universe.length) throw new Error("trader/universe.txt is missing: run the scanner's `scan.py universe` once");
  // today's pre-market shortlist, when there is one: only its names (lib/data/shortlist.ts)
  if (opts.symbols) universe.splice(0, universe.length, ...opts.symbols.map((s) => s.toUpperCase()));
  const exclude = new Set((opts.exclude ?? []).map((s) => s.toUpperCase()));
  const batches: string[][] = [];
  for (let i = 0; i < universe.length; i += SPARK_MAX) batches.push(universe.slice(i, i + SPARK_MAX));
  const sparks = Object.assign({}, ...(await pool(batches, 8, (b) => spark(b).catch(() => ({})))));
  const { date } = nyClock(nowMs);
  const minPrice = opts.minPrice ?? 5, minDollar = opts.minDollarVolume ?? 5_000_000;
  const stage1 = Object.entries(sparks as Record<string, Spark>)
    .filter(([sym, s]) => {
      if (exclude.has(sym)) return false;
      const price = s.price ?? s.closes[s.closes.length - 1];
      if (!(price >= minPrice && price <= opts.maxPrice)) return false;
      if (!((s.volume ?? 0) * price >= minDollar)) return false;
      const today = s.closes.map((c, i) => ({ c, t: s.t[i] })).filter((x) => Number.isFinite(x.c) && nyClock(x.t).date === date && nyClock(x.t).minute >= 570);
      if (today.length < 4) return false;
      const orClose = Math.max(...today.slice(0, 3).map((x) => x.c));
      return !today.slice(3).some((x) => x.c > orClose * 1.003) && (orClose - today[today.length - 1].c) / orClose <= 0.02;
    })
    .sort((a, b) => (b[1].volume ?? 0) * (b[1].price ?? 0) - (a[1].volume ?? 0) * (a[1].price ?? 0))
    .map(([sym]) => sym);
  const toConfirm = stage1.slice(0, opts.confirm ?? 60);
  const checked = await pool(toConfirm, 6, async (sym) => {
    const r = pendingRange(sym, await getIntraday(sym).catch(() => []), { nowMs, minRangePct: opts.minRangePct });
    if (!isPending(r)) return r;
    // Daily trend, only for the ranges that passed (few): a stock under its 20- and 50-day averages is left out.
    const t = dailyTrend(await getDailyHistory(sym).catch(() => []), date, r.last);
    if (t && "why" in t) return { symbol: sym, why: t.why };
    return t ? { ...r, ...t } : r;
  });
  const rejected: Record<string, number> = {};
  const reason = (why: string) => (why.startsWith("daily downtrend") ? "daily downtrend (under its 20- and 50-day averages)" : why.replace(/[\d.]+%/, "x%"));
  for (const c of checked) if (!isPending(c)) rejected[reason(c.why)] = (rejected[reason(c.why)] ?? 0) + 1;
  return { at: new Date(nowMs).toISOString(), universe: universe.length, stage1: stage1.length, confirmed: toConfirm.length, pending: rankPending(checked.filter(isPending)).slice(0, opts.limit ?? 8), rejected };
}
