// The strategist's backtest: every strategy in lib/strategies.ts replayed over Yahoo's ~60 days of
// 5-minute bars, on each morning's shortlist rebuilt from the closes known the evening before (the same
// screenDaily() rules the screener uses, top 40), so no pick uses hindsight.
//
//   npm run -s research               all strategies, the user's budget from trader/config.json
//   npm run -s research -- --budget 1000
//
// Writes trader/research/results-<date>.json (and latest.json) and prints the same as JSON.
// One caveat it reports itself: Yahoo's free daily feed gives only the latest volume, so the shortlist's
// liquidity rule uses today's volume for every past day.
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getIntraday } from "../lib/data";
import { pool, spark, SPARK_MAX, type Spark } from "../lib/data/pending";
import { nyClock, type IntradayBar } from "../lib/setups";
import { isPick, rankShortlist, return20, screenDaily, type ShortlistPick } from "../lib/shortlist";
import { runStrategy, STRATEGY_ROSTER, strategyStats, type Trade } from "../lib/strategies";

const argv = process.argv.slice(2);
const flag = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const root = (...p: string[]) => resolve(process.cwd(), "trader", ...p);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function retry<T>(fn: () => Promise<T>, tries = 4): Promise<T> {
  for (let k = 1; ; k++) {
    try { return await fn(); } catch (e) { if (k >= tries) throw e; await wait(1500 * k); }
  }
}

async function main() {
  const cfg = JSON.parse(await readFile(root("config.json"), "utf8").catch(() => "{}"));
  const budget = Number(flag("budget")) || Number(cfg.budget) || 200;
  const riskPct = Number(cfg.risk_pct) || 2;
  const maxPositionPct = Number(cfg.max_position_pct) || 75;
  const maxPrice = Number(flag("max-price")) || Math.max(5, Math.min(budget * 0.75, 1000));
  const today = nyClock(Date.now()).date;
  const cacheDir = root("research", "cache");
  await mkdir(cacheDir, { recursive: true });
  // the cache is for today only (a few hundred MB of 5-minute bars): drop earlier days' files
  for (const f of await readdir(cacheDir).catch(() => [] as string[])) if (/^(daily|5m)-\d{4}-\d{2}-\d{2}\.json$/.test(f) && !f.includes(today)) await unlink(join(cacheDir, f)).catch(() => undefined);

  // 1. daily closes for the whole universe (cached for the day)
  const dailyFile = join(cacheDir, `daily-${today}.json`);
  let daily: Record<string, Spark> = JSON.parse(await readFile(dailyFile, "utf8").catch(() => "null")) ?? {};
  if (!Object.keys(daily).length) {
    const text = await readFile(root("universe.txt"), "utf8").catch(() => "");
    const universe = text.split("\n").map((l) => l.split("|")[0].trim().toUpperCase()).filter((s) => /^[A-Z][A-Z0-9.]{0,6}$/.test(s));
    if (!universe.length) throw new Error("trader/universe.txt is empty: run the scanner once (`/trader-scanner`) to build the list");
    const batches: string[][] = [];
    for (let i = 0; i < universe.length; i += SPARK_MAX) batches.push(universe.slice(i, i + SPARK_MAX));
    daily = Object.assign({}, ...(await pool(batches, 6, (b) => retry(() => spark(b, "6mo", "1d")).catch(() => ({})))));
    const spy = await retry(() => spark(["SPY"], "6mo", "1d"));
    daily.SPY = spy.SPY;
    await writeFile(dailyFile, JSON.stringify(daily));
  }
  const spy = daily.SPY;
  if (!spy) throw new Error("no SPY closes from Yahoo");
  const dayOf = (t: number) => nyClock(t).date;
  const spyDays = spy.t.map(dayOf);

  // 2. the sessions with 5-minute bars (SPY's), and each one's shortlist from the evening before
  const spy5 = await retry(() => getIntraday("SPY"));
  const sessions = [...new Set(spy5.map((b) => dayOf(b.t)))].sort().filter((d) => d < today);
  const lists = new Map<string, ShortlistPick[]>();
  for (const day of sessions) {
    const k = spyDays.indexOf(day);
    if (k < 21) continue;
    const spyR = return20(spy.closes.slice(0, k).filter(Number.isFinite)) ?? undefined;
    const picks: ShortlistPick[] = [];
    for (const [sym, s] of Object.entries(daily)) {
      if (sym === "SPY" || !s?.t?.length) continue;
      const days = s.t.map(dayOf);
      const i = days.indexOf(spyDays[k - 1]);
      if (i < 50) continue;
      const r = screenDaily(sym, s.closes.slice(0, i + 1), s.volume, { maxPrice, spyReturn20: spyR });
      if (isPick(r)) picks.push(r);
    }
    lists.set(day, rankShortlist(picks).slice(0, 40));
  }
  const need = [...new Set([...lists.values()].flat().map((p) => p.symbol))];

  // 3. 5-minute bars for every shortlisted name (cached for the day)
  const fiveFile = join(cacheDir, `5m-${today}.json`);
  const five: Record<string, IntradayBar[]> = JSON.parse(await readFile(fiveFile, "utf8").catch(() => "null")) ?? {};
  const missing = need.filter((s) => !five[s]);
  let n = 0;
  await pool(missing, 3, async (s) => {
    five[s] = await retry(() => getIntraday(s)).catch(() => []);
    if (++n % 50 === 0) { process.stderr.write(`  5-minute bars ${n}/${missing.length}\n`); await writeFile(fiveFile, JSON.stringify(five)); }
  });
  await writeFile(fiveFile, JSON.stringify(five));

  // 4. every strategy on every shortlisted stock-day
  const trades: Record<string, Trade[]> = Object.fromEntries(STRATEGY_ROSTER.map((s) => [s.id, []]));
  let stockDays = 0;
  for (const [day, list] of lists) {
    for (const p of list) {
      const all = five[p.symbol] ?? [];
      const bars = all.filter((b) => { const c = nyClock(b.t); return c.date === day && c.minute >= 570 && c.minute < 960; });
      if (bars.length < 70) continue;
      stockDays++;
      const before = all.filter((b) => { const c = nyClock(b.t); return c.date < day && c.minute >= 570 && c.minute < 960; });
      const prevClose = before.length ? before[before.length - 1].close : undefined;
      for (const s of STRATEGY_ROSTER) {
        const t = runStrategy(s, bars, prevClose);
        if (t) trades[s.id].push(t);
      }
    }
  }
  const stats = STRATEGY_ROSTER.map((s) => strategyStats(s, trades[s.id], budget, riskPct, maxPositionPct)).sort((a, b) => b.grossR - a.grossR);
  const doc = {
    ranAt: new Date().toISOString(),
    sessions: { from: [...lists.keys()][0], to: [...lists.keys()].at(-1), count: lists.size },
    stockDays,
    budget,
    riskPct,
    method: "Each morning's top-40 shortlist rebuilt from the closes known the evening before; completed 5-minute bars only; stop first when a bar touches both; target 2R; sold at the 3:55 bar's close; IBKR fixed-pricing fees in net figures.",
    caveats: ["Yahoo's free daily feed gives only the latest volume, so the shortlist's liquidity rule used today's volume for every past day.", "About 60 sessions of 5-minute bars: a few hundred trades per strategy at most. Treat anything short of 'edge' as unproven."],
    strategies: stats,
  };
  await mkdir(root("research"), { recursive: true });
  await writeFile(root("research", `results-${today}.json`), JSON.stringify(doc, null, 2));
  await writeFile(root("research", "latest.json"), JSON.stringify(doc, null, 2));
  console.log(JSON.stringify(doc, null, 2));
}

main().catch((e) => {
  console.log(JSON.stringify({ ok: false, error: String(e?.message ?? e) }));
  process.exit(1);
});
